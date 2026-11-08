import * as UAST from '@ant-yasa/uast-spec';
import { internals, NodeHandler } from '@ant-yasa/uast-parser-c';
import { NAMESPACE, currentNamespace, flatten, joinScope, splitQualified } from './common';

const DEFINITIONS = new Set(['FunctionDefinition', 'VariableDeclaration', 'ClassDefinition']);

/**
 * Record the namespace on definitions that do not have one yet (inner
 * namespaces mark their own members first).
 * @param items - visited members of a namespace body
 * @param namespace - namespace of these members
 * @param anonymous - members of an anonymous namespace (internal linkage)
 */
function markMembers(items: any[], namespace: string, anonymous: boolean): void {
    for (const item of flatten(items)) {
        if (!DEFINITIONS.has(item.type) || !item._meta) continue;
        if (anonymous) item._meta.anonymousNamespace = true;
        if (!namespace || item._meta.namespace !== undefined) continue;
        item._meta.namespace = namespace;
        if (item.id?.name) item._meta.qualifiedName = joinScope(namespace, item.id.name);
    }
}

/** `namespace A { ... }`, `namespace A::B { ... }` and anonymous namespaces. */
const namespaceDefinition: NodeHandler = (node, opts) => {
    const nameNode = node.childForFieldName('name');
    const outer = currentNamespace(opts);
    const own = !nameNode ? '' : nameNode.type === 'nested_namespace_specifier'
        ? nameNode.namedChildren.map((c: any) => c.text).join('::')
        : nameNode.text;
    const namespace = joinScope(outer, own);
    const body = node.childForFieldName('body');
    const items = body ? internals.visitStatements(body.namedChildren, { ...opts, [NAMESPACE]: namespace }) : [];
    markMembers(items, namespace, !nameNode);
    const seq = UAST.sequence(items);
    seq._meta.namespace = namespace;
    return internals.appendNodeMeta(seq, node, opts.sourcefile);
};

/** `A::B::f` in an expression: the name, with its qualifier in `_meta.qualifier`. */
const qualifiedIdentifier: NodeHandler = (node, opts, next) => {
    const { qualifier, name } = splitQualified(node);
    if (name?.type !== 'identifier') return next(node, opts);
    const id = internals.cIdentifier(name.text, node, opts.sourcefile);
    id._meta.qualifier = qualifier;
    return id;
};

/** Unqualified identifiers carry the namespace they appear in, for name lookup. */
const identifier: NodeHandler = (node, opts, next) => {
    const result = next(node, opts);
    if (result?.type === 'Identifier' && result._meta) result._meta.namespaceContext = currentNamespace(opts);
    return result;
};

/** `using namespace A;` and `using A::f;` */
const usingDeclaration: NodeHandler = (node, opts) => {
    const target = (node.namedChildren[0]?.text ?? '').replace(/\s+/g, '');
    const noop = UAST.noop();
    const isNamespace = node.children.some((c: any) => c.type === 'namespace');
    noop._meta[isNamespace ? 'usingNamespace' : 'usingDeclaration'] = target;
    noop._meta.namespaceContext = currentNamespace(opts);
    return internals.appendNodeMeta(noop, node, opts.sourcefile);
};

export const namespaceHandlers: Record<string, NodeHandler> = {
    namespace_definition: namespaceDefinition,
    qualified_identifier: qualifiedIdentifier,
    identifier,
    using_declaration: usingDeclaration,
};
