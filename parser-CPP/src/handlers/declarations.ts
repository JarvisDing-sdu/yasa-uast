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
    for (let current = node; current; current = current.childForFieldName('declarator') ?? current.namedChildren.find((child: SyntaxNode) => child.type.endsWith('declarator')) ?? null) {
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
    const definitionName = nameNode?.type === 'qualified_identifier' ? splitQualified(nameNode).name : nameNode;
    if (definitionName) result.id = internals.cIdentifier(definitionName.text, definitionName, opts.sourcefile);
    if (namespace) {
        result._meta.namespace = namespace;
        if (result.id?.name) result._meta.qualifiedName = joinScope(namespace, result.id.name);
    }
    let enclosing = node.parent;
    while (enclosing && !['class_specifier', 'struct_specifier', 'namespace_definition', 'translation_unit'].includes(enclosing.type)) {
        enclosing = enclosing.parent;
    }
    const recordName = ['class_specifier', 'struct_specifier'].includes(enclosing?.type ?? '')
        ? enclosing?.childForFieldName('name')?.text : undefined;
    const owner = (recordName ?? namespace.split('::').at(-1))?.replace(/<.*>$/, '');
    if (!node.childForFieldName('type') && owner && result.id?.name === owner) {
        result._meta.isConstructor = true;
        const initializers = node.namedChildren.find((child: SyntaxNode) => child.type === 'field_initializer_list');
        if (initializers) {
            result._meta.cppConstructorInitializers = initializers.text;
            result._meta.unhandled = { kind: 'cpp_constructor_initializer_semantics' };
        }

    }
    const parameterNodes = declarator?.childForFieldName('parameters')?.namedChildren ?? [];
    const supportedParameters = parameterNodes.filter((parameter: SyntaxNode) => ['parameter_declaration', 'optional_parameter_declaration', 'variadic_parameter_declaration'].includes(parameter.type));
    if (!(supportedParameters.length === 1 && supportedParameters[0].text === 'void')) {
        result.parameters = supportedParameters.map((parameter: SyntaxNode) => internals.visit(parameter, opts));
    }
    const params = supportedParameters.map((parameter: SyntaxNode) => parameter.childForFieldName('declarator')).filter(Boolean);
    const returnReference = referenceKind(node.childForFieldName('declarator'));
    if (returnReference) result._meta.cppReturnReference = returnReference;
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
    const type = node.childForFieldName('type');
    if (type?.type === 'class_specifier' && type.childForFieldName('body')) {
        return internals.appendNodeMeta(UAST.sequence([internals.visit(type, opts), ...declarations]), node, opts.sourcefile);
    }
    return result;
};

/** Reuse C parameter conversion and retain C++ default values and parameter packs. */
const parameterDeclaration: NodeHandler = (node, opts) => {
    const parameter = internals.createParameter(node, opts);
    const value = node.childForFieldName('default_value');
    if (value) parameter.init = internals.expressionOrNoop(value, opts);
    const reference = referenceKind(node.childForFieldName('declarator'));
    if (reference) parameter._meta.reference = reference;
    if (node.type === 'variadic_parameter_declaration') parameter._meta.cppParameterPack = true;
    return parameter;
};

/** Preserve a function-template definition, without claiming instantiation or overload resolution. */
const templateDeclaration: NodeHandler = (node, opts, next) => {
    const definition = node.namedChildren.find((child: SyntaxNode) => ['function_definition', 'class_specifier', 'struct_specifier'].includes(child.type));
    if (!definition) return next(node, opts);
    const declarator = functionDeclarator(definition.childForFieldName('declarator'));
    const name = definition.type === 'function_definition' ? declarator?.childForFieldName('declarator') : definition.childForFieldName('name');
    if (!name || !['identifier', 'field_identifier', 'qualified_identifier', 'type_identifier', 'template_type'].includes(name.type)) return next(node, opts);
    const result = internals.visit(definition, opts);
    if (!['FunctionDefinition', 'ClassDefinition'].includes(result?.type)) return result;
    result._meta.cppTemplate = { parameters: node.childForFieldName('parameters')?.text ?? '' };
    return result;
};

/** Preserve C++ class bodies, including member and nested template definitions. */
const classSpecifier: NodeHandler = (node, opts) => {
    const name = node.childForFieldName('name');
    const body = node.childForFieldName('body');
    if (!body) {
        const forward = UAST.noop();
        forward._meta.cppForwardDeclaration = name?.text ?? null;
        return internals.appendNodeMeta(forward, node, opts.sourcefile);
    }
    const namespace = joinScope(currentNamespace(opts), name?.text ?? 'anonymous_class');
    const members = flatten(body.namedChildren.map((child: SyntaxNode) => internals.visit(child, { ...opts, [NAMESPACE]: namespace })));
    const id = internals.cIdentifier(name?.text ?? 'anonymous_class', name || node, opts.sourcefile);
    const result = UAST.classDefinition(id, members, []);
    result._meta.kind = node.type === 'struct_specifier' ? 'struct' : 'class';
    result._meta.qualifiedName = namespace;
    const bases = node.namedChildren.find((child: SyntaxNode) => child.type === 'base_class_clause');
    if (bases) result._meta.cppBases = bases.text;
    return internals.appendNodeMeta(result, node, opts.sourcefile);
};

const accessSpecifier: NodeHandler = (node, opts) => {
    const marker = UAST.noop();
    marker._meta.cppAccess = node.text;
    return internals.appendNodeMeta(marker, node, opts.sourcefile);
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
    field_declaration: declaration,
    template_declaration: templateDeclaration,
    alias_declaration: typeAlias,
    class_specifier: classSpecifier,
    access_specifier: accessSpecifier,
    parameter_declaration: parameterDeclaration,
    optional_parameter_declaration: parameterDeclaration,
    variadic_parameter_declaration: parameterDeclaration,
};
