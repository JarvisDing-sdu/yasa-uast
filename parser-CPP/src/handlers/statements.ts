import * as UAST from '@ant-yasa/uast-spec';
import { internals, NodeHandler } from '@ant-yasa/uast-parser-c';
import { declaredName, referenceKind } from './common';

/** Keep the range expression, element binding, and loop body in the common UAST form. */
const forRange: NodeHandler = (node, opts, next) => {
    const declarator = node.childForFieldName('declarator');
    if (declarator?.text.includes('[')) return next(node, opts);
    const name = declaredName(declarator);
    if (!name) return next(node, opts);
    const type = internals.applyDeclaratorType(internals.mapTypeSpecifier(node.childForFieldName('type'), opts), declarator, opts);
    const binding = internals.appendNodeMeta(UAST.variableDeclaration(
        internals.cIdentifier(name.text, name, opts.sourcefile), null, false, type,
    ), declarator, opts.sourcefile);
    const reference = referenceKind(declarator);
    if (reference) binding._meta.reference = reference;
    const loop = internals.appendNodeMeta(UAST.rangeStatement(null, binding,
        internals.expressionOrNoop(node.childForFieldName('right'), opts),
        internals.visit(node.childForFieldName('body'), opts),
    ), node, opts.sourcefile);
    const initializer = node.childForFieldName('initializer');
    return initializer ? internals.appendNodeMeta(UAST.scopedStatement([
        ...internals.visitStatements(initializer.namedChildren, opts), loop,
    ]), node, opts.sourcefile) : loop;
};

const catchClause: NodeHandler = (node, opts) => {
    const parameters = node.childForFieldName('parameters');
    const bindings = (parameters?.namedChildren ?? []).map(parameter => {
        const binding = internals.visit(parameter, opts);
        const reference = referenceKind(parameter.childForFieldName('declarator'));
        if (reference && binding?._meta) binding._meta.reference = reference;
        return binding;
    });
    const clause = UAST.catchClause(bindings, internals.visit(node.childForFieldName('body'), opts));
    if (parameters?.text === '(...)') clause._meta.cppCatchAll = true;
    return internals.appendNodeMeta(clause, node, opts.sourcefile);
};

export const statementHandlers: Record<string, NodeHandler> = {
    for_range_loop: forRange,
    try_statement: (node, opts) => internals.appendNodeMeta(UAST.tryStatement(
        internals.visit(node.childForFieldName('body'), opts),
        node.namedChildren.filter(child => child.type === 'catch_clause').map(child => internals.visit(child, opts)),
    ), node, opts.sourcefile),
    catch_clause: catchClause,
    throw_statement: (node, opts) => internals.appendNodeMeta(UAST.throwStatement(
        node.namedChildren.length ? internals.expressionOrNoop(node.namedChildren[0], opts) : null,
    ), node, opts.sourcefile),
};
