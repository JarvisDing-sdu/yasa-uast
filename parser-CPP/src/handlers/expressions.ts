import * as UAST from '@ant-yasa/uast-spec';
import { internals, NodeHandler } from '@ant-yasa/uast-parser-c';
import { currentNamespace, declaredName, IN_FUNCTION } from './common';

const CASTS = new Set(['static_cast', 'reinterpret_cast', 'const_cast', 'dynamic_cast']);

/** `static_cast<T>(e)` and the other named casts: a CastExpression. */
const callExpression: NodeHandler = (node, opts, next) => {
    const fn = node.childForFieldName('function');
    const castName = fn?.type === 'template_function' ? fn.childForFieldName('name')?.text : undefined;
    if (!castName || !CASTS.has(castName)) return next(node, opts);
    const typeNode = fn.childForFieldName('arguments')?.namedChildren[0] ?? null;
    const argument = node.childForFieldName('arguments')?.namedChildren.find((c: any) => c.type !== 'comment');
    const cast = UAST.castExpression(internals.expressionOrNoop(argument, opts), internals.mapTypeSpecifier(typeNode, opts));
    cast._meta.cppCast = castName;
    return internals.appendNodeMeta(cast, node, opts.sourcefile);
};

/**
 * The test of `if (init; cond)`, `if (T x = e)`, `switch` and `while`: the
 * condition value, or the declared variable when the condition is a declaration.
 */
const conditionClause: NodeHandler = (node, opts) => {
    const value = node.childForFieldName('value');
    if (value?.type === 'declaration') {
        const name = declaredName(value.childForFieldName('declarator'));
        const id = internals.cIdentifier(name?.text ?? '_', name ?? value, opts.sourcefile);
        id._meta.namespaceContext = currentNamespace(opts);
        return id;
    }
    return internals.expressionOrNoop(value, opts);
};

/**
 * Statements whose condition has an init statement or is a declaration: the
 * declaration runs first, in a scope around the statement.
 */
const withConditionDeclarations: NodeHandler = (node, opts, next) => {
    const condition = node.childForFieldName('condition');
    if (condition?.type !== 'condition_clause') return next(node, opts);
    const declarations = [
        ...(condition.childForFieldName('initializer')?.namedChildren ?? []),
        ...[condition.childForFieldName('value')].filter((v: any) => v?.type === 'declaration'),
    ];
    if (!declarations.length) return next(node, opts);
    if (node.type === 'while_statement') {
        const loop = next(node, opts);
        loop.test = internals.appendNodeMeta(UAST.sequence([
            ...internals.visitStatements(declarations, opts), loop.test,
        ]), condition, opts.sourcefile);
        return internals.appendNodeMeta(UAST.scopedStatement([loop]), node, opts.sourcefile);
    }
    const scoped = UAST.scopedStatement(internals.flattenInstructions([
        ...internals.visitStatements(declarations, opts),
        next(node, opts),
    ]));
    return internals.appendNodeMeta(scoped, node, opts.sourcefile);
};

const rawString: NodeHandler = (node, opts) => {
    const content = node.namedChildren.find((child: any) => child.type === 'raw_string_content');
    return internals.appendNodeMeta(UAST.literal(content?.text ?? '', 'string'), node, opts.sourcefile);
};

/** C++ grammar wraps subscript arguments in an indices list. */
const subscriptExpression: NodeHandler = (node, opts, next) => {
    const indices = node.childForFieldName('indices');
    if (!indices) return next(node, opts);
    const args = indices.namedChildren.filter((child: any) => child.type !== 'comment');
    const object = internals.expressionOrNoop(node.childForFieldName('argument'), opts);
    const index = args.length === 1
        ? internals.expressionOrNoop(args[0], opts)
        : internals.appendNodeMeta(UAST.tupleExpression(args.map((arg: any) => internals.expressionOrNoop(arg, opts))), indices, opts.sourcefile);
    return internals.appendNodeMeta(UAST.memberAccess(object, index, true), node, opts.sourcefile);
};

const templateName: NodeHandler = (node, opts, next) => {
    const name = node.childForFieldName('name');
    if (!name || !['identifier', 'field_identifier'].includes(name.type)) return next(node, opts);
    const id = internals.cIdentifier(name.text, node, opts.sourcefile);
    id._meta.cppTemplateArguments = node.childForFieldName('arguments')?.text ?? '';
    id._meta.namespaceContext = currentNamespace(opts);
    return id;
};

/** Preserve lambda bodies and explicitly record capture-model limits. */
const lambdaExpression: NodeHandler = (node, opts) => {
    const declarator = node.childForFieldName('declarator');
    const parameters = declarator?.childForFieldName('parameters')?.namedChildren ?? [];
    const body = node.childForFieldName('body');
    const result = UAST.functionDefinition(null,
        parameters.filter((parameter: any) => parameter.type.endsWith('parameter_declaration'))
            .map((parameter: any) => internals.visit(parameter, opts)),
        UAST.dynamicType(),
        body ? internals.visit(body, { ...opts, [IN_FUNCTION]: true }) : UAST.scopedStatement([]), []);
    const captures = node.childForFieldName('captures')?.text ?? '[]';
    const returnType = declarator?.namedChildren.find((child: any) => child.type === 'trailing_return_type');
    if (returnType) result.returnType = internals.mapTypeSpecifier(returnType.namedChildren.at(-1), opts);
    if (node.childForFieldName('template_parameters')) result._meta.cppTemplate = { parameters: node.childForFieldName('template_parameters')!.text };
    result._meta.cppLambda = { spelling: captures, captureSemantics: captures === '[]' ? 'captureless' : 'recorded_only' };
    if (captures !== '[]') result._meta.unhandled = { kind: 'cpp_lambda_capture_semantics' };
    return internals.appendNodeMeta(result, node, opts.sourcefile);
};

export const expressionHandlers: Record<string, NodeHandler> = {
    lambda_expression: lambdaExpression,
    this: (node, opts) => internals.appendNodeMeta(UAST.thisExpression(), node, opts.sourcefile),
    raw_string_literal: rawString,
    subscript_expression: subscriptExpression,
    template_function: templateName,
    template_method: templateName,
    call_expression: callExpression,
    condition_clause: conditionClause,
    if_statement: withConditionDeclarations,
    switch_statement: withConditionDeclarations,
    while_statement: withConditionDeclarations,
};
