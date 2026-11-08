import { NodeHandler } from '@ant-yasa/uast-parser-c';
import {
    IN_FUNCTION, SyntaxNode, currentNamespace, declaredName, flatten, joinScope, referenceKind, splitQualified,
} from './common';

/**
 * Mark reference declarations: `_meta.reference` on each declaration whose
 * declarator is `T&` or `T&&`, matched by declared name.
 * @param declarators - declarator nodes of the syntax
 * @param declarations - VariableDeclarations built from them
 */
function markReferences(declarators: SyntaxNode[], declarations: any[]): void {
    const kinds = new Map<string, 'lvalue' | 'rvalue'>();
    for (const d of declarators) {
        const kind = referenceKind(d);
        const name = declaredName(d)?.text;
        if (kind && name) kinds.set(name, kind);
    }
    for (const decl of declarations) {
        const kind = decl?.type === 'VariableDeclaration' ? kinds.get(decl.id?.name) : undefined;
        if (kind) decl._meta.reference = kind;
    }
}

/**
 * The function_declarator of a function definition's declarator chain.
 * @param node - declarator
 * @returns function_declarator, or null
 */
function functionDeclarator(node: SyntaxNode | null): SyntaxNode | null {
    for (let current = node; current; current = current.childForFieldName('declarator')) {
        if (current.type === 'function_declarator') return current;
    }
    return null;
}

/**
 * Function definitions: namespace (including `A::f` defined outside its
 * namespace; until classes are modelled every qualifier counts as a
 * namespace), and reference parameters. The body is visited with the
 * in-function flag so local variables are not taken for namespace members.
 */
const functionDefinition: NodeHandler = (node, opts, next) => {
    const result = next(node, { ...opts, [IN_FUNCTION]: true });
    if (result?.type !== 'FunctionDefinition') return result;
    const declarator = functionDeclarator(node.childForFieldName('declarator'));
    const nameNode = declarator?.childForFieldName('declarator');
    const qualifier = nameNode?.type === 'qualified_identifier' ? splitQualified(nameNode).qualifier : '';
    const namespace = joinScope(currentNamespace(opts), qualifier);
    if (namespace) {
        result._meta.namespace = namespace;
        if (result.id?.name) result._meta.qualifiedName = joinScope(namespace, result.id.name);
    }
    const params = (declarator?.childForFieldName('parameters')?.namedChildren ?? [])
        .map((p: SyntaxNode) => p.childForFieldName('declarator'))
        .filter(Boolean);
    markReferences(params, result.parameters || []);
    return result;
};

/** Declarations: reference variables, and namespace-scope variables. */
const declaration: NodeHandler = (node, opts, next) => {
    const result = next(node, opts);
    const declarations = flatten([result]);
    markReferences(node.childrenForFieldName('declarator'), declarations);
    const namespace = currentNamespace(opts);
    if (namespace && !opts[IN_FUNCTION]) {
        for (const decl of declarations) {
            if (decl.type !== 'VariableDeclaration' || decl._meta.namespace !== undefined) continue;
            decl._meta.namespace = namespace;
            decl._meta.qualifiedName = joinScope(namespace, decl.id.name);
        }
    }
    return result;
};

export const declarationHandlers: Record<string, NodeHandler> = {
    function_definition: functionDefinition,
    declaration,
};
