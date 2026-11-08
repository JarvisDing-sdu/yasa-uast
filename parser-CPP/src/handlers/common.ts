import type { NodeHandler } from '@ant-yasa/uast-parser-c';

export type SyntaxNode = Parameters<NodeHandler>[0];

/** Visitor-option keys owned by parser-CPP. */
export const NAMESPACE = '__cppNamespace';
export const IN_FUNCTION = '__cppInFunction';

/**
 * @param opts - visitor options
 * @returns the enclosing namespace, `''` at global scope
 */
export function currentNamespace(opts: Record<string, any>): string {
    return opts[NAMESPACE] ?? '';
}

/**
 * @param outer - namespace or qualifier
 * @param inner - name or nested namespace
 * @returns `outer::inner`, without empty parts
 */
export function joinScope(outer: string, inner: string): string {
    return outer && inner ? `${outer}::${inner}` : outer || inner;
}

/**
 * Split `A::B::f` (or `::g`) into its qualifier and final name node.
 * @param node - qualified_identifier
 * @returns qualifier (`''` for a global `::g`) and the innermost name node
 */
export function splitQualified(node: SyntaxNode): { qualifier: string; name: SyntaxNode | null } {
    const parts: string[] = [];
    let current: SyntaxNode | null = node;
    while (current?.type === 'qualified_identifier') {
        const scope = current.childForFieldName('scope');
        if (scope) parts.push(scope.text.replace(/\s+/g, ''));
        current = current.childForFieldName('name');
    }
    return { qualifier: parts.join('::'), name: current };
}

/**
 * The name node a declarator declares, looking through pointer, reference,
 * array, function and qualified declarators.
 * @param node - declarator
 * @returns identifier-like node, or null
 */
export function declaredName(node: SyntaxNode | null | undefined): SyntaxNode | null {
    if (!node) return null;
    if (['identifier', 'field_identifier', 'type_identifier'].includes(node.type)) return node;
    if (node.type === 'qualified_identifier') return splitQualified(node).name;
    const inner = node.childForFieldName('declarator');
    if (inner) return declaredName(inner);
    for (const child of node.namedChildren) {
        if (['parameter_list', 'attribute_specifier', 'type_qualifier'].includes(child.type)) continue;
        const found = declaredName(child);
        if (found) return found;
    }
    return null;
}

/**
 * @param node - declarator
 * @returns `'lvalue'` for `T&`, `'rvalue'` for `T&&`, undefined otherwise
 */
export function referenceKind(node: SyntaxNode | null | undefined): 'lvalue' | 'rvalue' | undefined {
    for (let current = node; current; ) {
        if (current.type === 'reference_declarator') return current.child(0)?.type === '&&' ? 'rvalue' : 'lvalue';
        current = current.childForFieldName('declarator') ?? current.namedChildren.find((c: SyntaxNode) => c.type.endsWith('declarator')) ?? null;
    }
    return undefined;
}

/**
 * Flatten Sequences into a list of nodes.
 * @param items - UAST nodes
 * @returns the nodes with Sequences replaced by their expressions
 */
export function flatten(items: any[]): any[] {
    return items.flatMap((item) => (item?.type === 'Sequence' ? flatten(item.expressions || []) : item ? [item] : []));
}
