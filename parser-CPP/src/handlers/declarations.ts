import * as UAST from '@ant-yasa/uast-spec';
import { internals, NodeHandler } from '@ant-yasa/uast-parser-c';
import {
    IN_FUNCTION, NAMESPACE, SyntaxNode, currentNamespace, declaredName, flatten, joinScope, referenceKind, splitQualified,
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
    const declarator = functionDeclarator(node.childForFieldName('declarator'));
    const nameNode = declarator?.childForFieldName('declarator');
    const qualifier = nameNode?.type === 'qualified_identifier' ? splitQualified(nameNode).qualifier : '';
    const namespace = nameNode?.text.trimStart().startsWith('::') ? qualifier : joinScope(currentNamespace(opts), qualifier);
    const result = next(node, { ...opts, [IN_FUNCTION]: true, [NAMESPACE]: namespace });
    if (result?.type !== 'FunctionDefinition') return result;
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
    // tree-sitter-cpp condition declarations put the initializer in `value`,
    // rather than wrapping the declarator in C's init_declarator.
    const value = node.childForFieldName('value');
    if (value && declarations.length === 1 && declarations[0]?.type === 'VariableDeclaration' && !declarations[0].init) {
        declarations[0].init = internals.expressionOrNoop(value, opts);
    }
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

/** Preserve a function-template definition, without claiming instantiation or overload resolution. */
const templateDeclaration: NodeHandler = (node, opts, next) => {
    const definition = node.namedChildren.find((child: SyntaxNode) => child.type === 'function_definition');
    if (!definition) return next(node, opts);
    const declarator = functionDeclarator(definition.childForFieldName('declarator'));
    const name = declarator?.childForFieldName('declarator');
    if (!name || !['identifier', 'qualified_identifier'].includes(name.type)) return next(node, opts);
    const result = internals.visit(definition, opts);
    if (result?.type !== 'FunctionDefinition') return result;
    result._meta.cppTemplate = { parameters: node.childForFieldName('parameters')?.text ?? '' };
    return result;
};

/** Retain a using-alias in the same metadata form as a C typedef. */
const typeAlias: NodeHandler = (node, opts, next) => {
    const name = node.childForFieldName('name');
    const type = node.childForFieldName('type');
    if (!name || !type) return next(node, opts);
    const noop = UAST.noop();
    noop._meta.typedef = { name: name.text, type: internals.mapTypeSpecifier(type, opts) };
    const namespace = currentNamespace(opts);
    if (namespace) noop._meta.namespace = namespace;
    return internals.appendNodeMeta(noop, node, opts.sourcefile);
};

export const declarationHandlers: Record<string, NodeHandler> = {
    function_definition: functionDefinition,
    declaration,
    template_declaration: templateDeclaration,
    alias_declaration: typeAlias,
};
