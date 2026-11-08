import * as UAST from '@ant-yasa/uast-spec';
import { internals, NodeHandler } from '@ant-yasa/uast-parser-c';
import { currentNamespace, declaredName } from './common';

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
    const scoped = UAST.scopedStatement(internals.flattenInstructions([
        ...internals.visitStatements(declarations, opts),
        next(node, opts),
    ]));
    return internals.appendNodeMeta(scoped, node, opts.sourcefile);
};

export const expressionHandlers: Record<string, NodeHandler> = {
    call_expression: callExpression,
    condition_clause: conditionClause,
    if_statement: withConditionDeclarations,
    switch_statement: withConditionDeclarations,
    while_statement: withConditionDeclarations,
};
