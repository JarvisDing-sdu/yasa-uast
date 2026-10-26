import * as TreeSitter from 'web-tree-sitter';
import * as UAST from '@ant-yasa/uast-spec';
import { version } from '../package.json';
import { MacroEnvironment, substitute, MacroDefinition, PreprocessorConfig } from './macros';

type SyntaxNode = TreeSitter.Node;

export interface ParseError {
    line: number;
    column: number;
    kind: 'error' | 'missing';
    text: string;
}

let parserInstance: TreeSitter.Parser | null = null;
let initialization: Promise<void> | null = null;

export function init(): Promise<void> {
    if (!initialization) {
        initialization = (async () => {
            await TreeSitter.Parser.init();
            const Lang = await TreeSitter.Language.load(
                require.resolve('tree-sitter-c/tree-sitter-c.wasm')
            );
            const parser = new TreeSitter.Parser();
            parser.setLanguage(Lang);
            parserInstance = parser;
        })().catch((error) => {
            initialization = null;
            throw error;
        });
    }
    return initialization;
}

function getParser(): TreeSitter.Parser {
    if (!parserInstance) {
        throw new Error('Parser not initialized. Call init() first.');
    }
    return parserInstance;
}

function toSourceLocation(node: SyntaxNode, sourcefile?: string) {
    return {
        start: {
            line: node.startPosition.row + 1,
            column: node.startPosition.column + 1,
        },
        end: {
            line: node.endPosition.row + 1,
            column: node.endPosition.column + 1,
        },
        sourcefile,
    };
}

function appendNodeMeta<T>(uastNode: T, tsNode: SyntaxNode | null | undefined, sourcefile?: string): T {
    if (!uastNode || typeof uastNode !== 'object' || !UAST.isNode(uastNode as any)) {
        return uastNode;
    }

    if (tsNode) {
        const loc = toSourceLocation(tsNode, sourcefile);
        (uastNode as any).loc = loc;
        (uastNode as any)._meta.loc = loc;
        // Keep only the node kind: storing node text on every node makes the
        // UAST quadratic in file size because each ancestor repeats its children.
        (uastNode as any)._meta.origin = { type: tsNode.type };
    }

    return uastNode;
}

function visitList(nodes: SyntaxNode[], opts: Record<string, any>): Array<any> {
    return nodes
        .map((node) => visit(node, opts))
        .filter((node) => node !== null && node !== undefined);
}

/**
 * Visit statement-level nodes so that one unsupported construct degrades to a
 * Noop instead of discarding the whole file. `strict` rethrows.
 */
function visitStatements(nodes: SyntaxNode[], opts: Record<string, any>): Array<any> {
    return flattenInstructions(nodes.map((node) => {
        try {
            return visit(node, opts);
        } catch (error) {
            if (opts?.strict) throw error;
            const noop = UAST.noop();
            noop._meta.buildError = { kind: node.type, message: String((error as Error)?.message ?? error).slice(0, 200) };
            return appendNodeMeta(noop, node, opts?.sourcefile);
        }
    }));
}

/**
 * uast-spec only accepts Identifier/MemberAccess-like LVals, but C assigns
 * through `*p` and casts. Build with a placeholder, then set the real target.
 */
function assignment(left: UAST.Expression, right: UAST.Expression, operator: string): UAST.AssignmentExpression {
    const expr = UAST.assignmentExpression(UAST.identifier('_'), right, operator as any, false);
    (expr as any).left = left;
    return expr;
}

function flattenInstructions(nodes: Array<any>): Array<any> {
    const instructions: Array<any> = [];
    for (const node of nodes) {
        if (!node) continue;
        if (UAST.isSequence(node)) {
            instructions.push(...flattenInstructions(node.expressions));
            continue;
        }
        instructions.push(node);
    }
    return instructions;
}

function namedChild(node: SyntaxNode, index: number): SyntaxNode | null {
    return node.namedChildren[index] || null;
}

// web-tree-sitter returns a fresh wrapper object for every child access, so
// syntax nodes must be compared by id rather than by reference.
function sameNode(a: SyntaxNode | null | undefined, b: SyntaxNode | null | undefined): boolean {
    return !!a && !!b && a.id === b.id;
}

/** Named children that are not bound to any of the given fields. */
function unfieldedNamedChildren(node: SyntaxNode, fields: string[]): SyntaxNode[] {
    const excluded = fields.flatMap((field) => node.childrenForFieldName(field));
    return node.namedChildren.filter((child) => !excluded.some((other) => sameNode(child, other)));
}

function getOperator(node: SyntaxNode): string {
    for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i)!;
        if (!child.isNamed && !['(', ')', '[', ']', '{', '}', ',', ';', ':'].includes(child.text)) {
            return child.text;
        }
    }
    return '';
}

function cIdentifier(name: string, node?: SyntaxNode | null, sourcefile?: string): UAST.Identifier {
    return appendNodeMeta(UAST.identifier(name || '_'), node, sourcefile);
}

function dynamicType(node?: SyntaxNode | null, sourcefile?: string): UAST.DynamicType {
    return appendNodeMeta(UAST.dynamicType(), node, sourcefile);
}

function voidType(node?: SyntaxNode | null, sourcefile?: string): UAST.VoidType {
    return appendNodeMeta(UAST.voidType(cIdentifier('void', node, sourcefile)), node, sourcefile);
}

function primitiveType(name: string, node?: SyntaxNode | null, sourcefile?: string): UAST.PrimitiveType {
    const normalized = name.replace(/\s+/g, ' ').trim();
    const typeNode = UAST.primitiveType(cIdentifier(normalized, node, sourcefile));
    const kind = normalized === '_Bool' || normalized === 'bool' ? 'boolean'
        : normalized === 'char' || normalized.includes('char') ? 'string'
            : 'number';
    (typeNode as any).kind = kind;
    return appendNodeMeta(typeNode, node, sourcefile);
}

function pointerType(element: UAST.Type, node?: SyntaxNode | null, sourcefile?: string): UAST.PointerType {
    const ptr = UAST.pointerType(cIdentifier('pointer', node, sourcefile), element);
    (ptr as any).kind = 'pointer';
    return appendNodeMeta(ptr, node, sourcefile);
}

function arrayType(element: UAST.Type, size?: UAST.Expression | null, node?: SyntaxNode | null, sourcefile?: string): UAST.ArrayType {
    return appendNodeMeta(UAST.arrayType(cIdentifier('array', node, sourcefile), element, null, size || null), node, sourcefile);
}

function mapTypeSpecifier(node: SyntaxNode | null | undefined, opts: Record<string, any>): UAST.Type {
    const sourcefile = opts?.sourcefile as string | undefined;
    if (!node) return dynamicType(null, sourcefile);

    switch (node.type) {
        case 'primitive_type':
            if (node.text === 'void') return voidType(node, sourcefile);
            return primitiveType(node.text, node, sourcefile);
        case 'sized_type_specifier':
            return primitiveType(node.text, node, sourcefile);
        case 'type_identifier':
        case 'identifier':
            return cIdentifier(node.text, node, sourcefile) as any;
        case 'type_descriptor': {
            const base = mapTypeSpecifier(node.childForFieldName('type'), opts);
            return applyDeclaratorType(base, node.childForFieldName('declarator'), opts);
        }
        case 'struct_specifier':
        case 'union_specifier':
        case 'enum_specifier': {
            const nameNode = node.childForFieldName('name');
            const id = cIdentifier(nameNode ? nameNode.text : node.type.replace('_specifier', ''), nameNode || node, sourcefile);
            const st = UAST.scopedType(id, null);
            (st as any)._meta.kind = node.type.replace('_specifier', '');
            return appendNodeMeta(st, node, sourcefile);
        }
        default:
            if (node.namedChildren.length === 1) {
                return mapTypeSpecifier(node.namedChildren[0], opts);
            }
            return cIdentifier(node.text, node, sourcefile) as any;
    }
}

function declaratorName(node: SyntaxNode | null | undefined): SyntaxNode | null {
    if (!node) return null;
    if (['identifier', 'field_identifier', 'type_identifier'].includes(node.type)) return node;
    const named = node.childForFieldName('declarator');
    if (named) return declaratorName(named);
    for (const child of node.namedChildren) {
        if (['parameter_list', 'attribute_specifier', 'type_qualifier'].includes(child.type)) continue;
        const found = declaratorName(child);
        if (found) return found;
    }
    return null;
}

/** Innermost declarator kind, ignoring pointer/paren wrappers, e.g. `*f(int)` is a function. */
function isFunctionDeclarator(node: SyntaxNode | null | undefined): boolean {
    while (node) {
        if (node.type === 'function_declarator') {
            // `(*fp)(int)` declares a pointer to function, which is a variable.
            const inner = node.childForFieldName('declarator');
            return inner?.type !== 'parenthesized_declarator';
        }
        if (!['pointer_declarator', 'attributed_declarator'].includes(node.type)) return false;
        node = node.childForFieldName('declarator');
    }
    return false;
}

/**
 * C declarators read inside-out: in `T *D` the pointer derives from T and D
 * then derives further, so `char *xs[4]` is an array of pointers and
 * `void (*fp)(int)` is a pointer to a function.
 */
function applyDeclaratorType(base: UAST.Type, declarator: SyntaxNode | null | undefined, opts: Record<string, any>): UAST.Type {
    const sourcefile = opts?.sourcefile as string | undefined;
    if (!declarator) return base;

    switch (declarator.type) {
        case 'pointer_declarator':
        case 'abstract_pointer_declarator':
            return applyDeclaratorType(pointerType(base, declarator, sourcefile), declarator.childForFieldName('declarator'), opts);
        case 'array_declarator':
        case 'abstract_array_declarator': {
            const sizeNode = declarator.childForFieldName('size');
            const size = sizeNode ? visit(sizeNode, opts) as UAST.Expression : null;
            return applyDeclaratorType(arrayType(base, size, declarator, sourcefile), declarator.childForFieldName('declarator'), opts);
        }
        case 'function_declarator':
        case 'abstract_function_declarator': {
            const paramsNode = declarator.childForFieldName('parameters');
            const params = paramsNode
                ? paramsNode.namedChildren
                    .filter((p) => p.type === 'parameter_declaration')
                    .map((p) => parameterType(p, opts))
                : [];
            const fn = appendNodeMeta(UAST.funcType(cIdentifier('function', declarator, sourcefile), [], params, [base]), declarator, sourcefile);
            return applyDeclaratorType(fn, declarator.childForFieldName('declarator'), opts);
        }
        case 'parenthesized_declarator':
        case 'abstract_parenthesized_declarator':
        case 'attributed_declarator':
            return applyDeclaratorType(base, namedChild(declarator, 0), opts);
        case 'init_declarator':
            return applyDeclaratorType(base, declarator.childForFieldName('declarator'), opts);
        default:
            return base;
    }
}

function returnTypeFromFunction(typeNode: SyntaxNode | null, declarator: SyntaxNode | null, opts: Record<string, any>): UAST.Type {
    const base = mapTypeSpecifier(typeNode, opts);
    // Unwrap pointer declarators down to the function declarator: they belong to the return type.
    const wrappers: SyntaxNode[] = [];
    let current = declarator;
    while (current && current.type !== 'function_declarator') {
        wrappers.push(current);
        current = current.childForFieldName('declarator');
    }
    let result = base;
    for (const wrapper of wrappers.reverse()) {
        if (wrapper.type === 'pointer_declarator') result = pointerType(result, wrapper, opts?.sourcefile);
    }
    return result;
}

function parameterType(paramNode: SyntaxNode, opts: Record<string, any>): UAST.Type {
    return applyDeclaratorType(
        mapTypeSpecifier(paramNode.childForFieldName('type'), opts),
        paramNode.childForFieldName('declarator'),
        opts
    );
}

function createParameter(paramNode: SyntaxNode, opts: Record<string, any>): UAST.VariableDeclaration {
    const sourcefile = opts?.sourcefile as string | undefined;
    const nameNode = declaratorName(paramNode.childForFieldName('declarator'));
    const id = cIdentifier(nameNode ? nameNode.text : '_', nameNode || paramNode, sourcefile);
    const decl = UAST.variableDeclaration(id, null, false, parameterType(paramNode, opts));
    decl._meta.isParameter = true;
    if (!nameNode) decl._meta.unnamed = true;
    return appendNodeMeta(decl, paramNode, sourcefile);
}

function functionParameters(declarator: SyntaxNode | null | undefined, opts: Record<string, any>): UAST.VariableDeclaration[] {
    let current = declarator;
    while (current && current.type !== 'function_declarator') current = current.childForFieldName('declarator');
    const paramsNode = current?.childForFieldName('parameters');
    if (!paramsNode) return [];
    const params = paramsNode.namedChildren.filter((p) => p.type === 'parameter_declaration');
    // `f(void)` declares no parameters.
    if (params.length === 1 && !params[0].childForFieldName('declarator') && params[0].childForFieldName('type')?.text === 'void') {
        return [];
    }
    return params.map((p) => createParameter(p, opts));
}

function storageClasses(node: SyntaxNode): string[] {
    return node.namedChildren.filter((c) => c.type === 'storage_class_specifier').map((c) => c.text);
}

function createDeclaration(node: SyntaxNode, opts: Record<string, any>): any {
    const sourcefile = opts?.sourcefile as string | undefined;
    const typeNode = node.childForFieldName('type');
    const typeOnlyDefinition = createTypeDefinition(typeNode, opts);
    const declarators = node.childrenForFieldName('declarator');
    const storage = storageClasses(node);

    if (declarators.length === 0) {
        return typeOnlyDefinition || appendNodeMeta(UAST.noop(), node, sourcefile);
    }

    const declarations = declarators.map((declNode) => {
        const declarator = declNode.type === 'init_declarator' ? declNode.childForFieldName('declarator') : declNode;
        const nameNode = declaratorName(declarator);
        if (isFunctionDeclarator(declarator)) {
            // A prototype must not shadow the function definition as an
            // uninitialised variable, so it is kept as metadata only.
            const noop = UAST.noop();
            noop._meta.prototype = nameNode?.text ?? null;
            if (storage.length) noop._meta.storage = storage;
            return appendNodeMeta(noop, declNode, sourcefile);
        }
        const valueNode = declNode.type === 'init_declarator' ? declNode.childForFieldName('value') : null;
        if (nameNode && (opts?.__unionTypes as Set<string> | undefined)?.has(typeKey(typeNode) ?? '')) {
            (opts.__unionVars as Set<string>).add(nameNode.text);
        }
        const id = cIdentifier(nameNode ? nameNode.text : '_', nameNode || declNode, sourcefile);
        const init = valueNode ? initializerFor(valueNode, typeNode, arrayDims(declarator), opts) : null;
        const varType = applyDeclaratorType(mapTypeSpecifier(typeNode, opts), declarator, opts);
        const varDecl = UAST.variableDeclaration(id, init, false, varType);
        if (!nameNode) varDecl._meta.unnamed = true;
        if (storage.length) varDecl._meta.storage = storage;
        return appendNodeMeta(varDecl, declNode, sourcefile);
    });

    const all = typeOnlyDefinition ? [typeOnlyDefinition, ...declarations] : declarations;
    if (all.length === 1) return all[0];
    return appendNodeMeta(UAST.sequence(all), node, sourcefile);
}

/** Lookup key for a struct type: `struct S`, `union U` or a typedef name. */
function typeKey(typeNode: SyntaxNode | null | undefined): string | null {
    if (!typeNode) return null;
    if (['struct_specifier', 'union_specifier'].includes(typeNode.type)) {
        const name = typeNode.childForFieldName('name');
        return name ? `${typeNode.type.replace('_specifier', '')} ${name.text}` : null;
    }
    if (typeNode.type === 'type_identifier') return typeNode.text;
    return null;
}

/**
 * Number of array dimensions applied directly to the declared name:
 * `int g[2][3]` → 2, `char *xs[4]` → 1, `char (*p)[4]` → 0 (a pointer).
 */
function arrayDims(declarator: SyntaxNode | null | undefined): number {
    const chain: SyntaxNode[] = [];
    let current = declarator;
    while (current && !['identifier', 'field_identifier', 'type_identifier'].includes(current.type)) {
        chain.push(current);
        current = ['parenthesized_declarator', 'attributed_declarator'].includes(current.type)
            ? namedChild(current, 0)
            : current.childForFieldName('declarator');
    }
    let dims = 0;
    for (let i = chain.length - 1; i >= 0; i--) {
        if (chain[i].type === 'array_declarator') dims++;
        else if (!['parenthesized_declarator', 'attributed_declarator'].includes(chain[i].type)) break;
    }
    return dims;
}

/**
 * Initializer lists keyed by what they initialise: array elements by index and
 * struct members by field name, so `arr[1]` or `p.safe` read the right entry.
 * Unknown struct types keep the positional TupleExpression.
 */
function initializerFor(valueNode: SyntaxNode, typeNode: SyntaxNode | null, dims: number, opts: Record<string, any>): any {
    const sourcefile = opts?.sourcefile as string | undefined;
    if (valueNode.type !== 'initializer_list') return visit(valueNode, opts);
    const children = valueNode.namedChildren.filter((c) => c.type !== 'comment');
    const isArray = dims > 0;
    const fields = isArray ? null : opts?.__structs?.get(typeKey(typeNode) ?? '') as string[] | undefined;
    if (!isArray && !fields) return visit(valueNode, opts);

    let position = 0;
    const properties = children.map((child) => {
        let key: any;
        let valueChild: SyntaxNode | null = child;
        if (child.type === 'initializer_pair') {
            const designator = child.childrenForFieldName('designator')[0];
            const keyNode = designator ? namedChild(designator, 0) : null;
            key = keyNode ? visit(keyNode, opts) : null;
            valueChild = child.childForFieldName('value');
            if (designator?.type === 'subscript_designator' && UAST.isLiteral(key) && typeof key.value === 'number') position = key.value;
            else if (designator?.type === 'field_designator' && fields) position = Math.max(0, fields.indexOf(keyNode!.text));
        } else if (isArray) {
            key = appendNodeMeta(UAST.literal(position, 'number'), child, sourcefile);
        } else {
            key = position < fields!.length ? cIdentifier(fields![position], child, sourcefile) : appendNodeMeta(UAST.literal(position, 'number'), child, sourcefile);
        }
        position++;
        const value = valueChild
            ? (isArray ? initializerFor(valueChild, typeNode, dims - 1, opts) : visit(valueChild, opts))
            : null;
        return appendNodeMeta(UAST.objectProperty(key || appendNodeMeta(UAST.literal(position - 1, 'number'), child, sourcefile), value), child, sourcefile);
    });
    const obj = UAST.objectExpression(properties);
    obj._meta.initializerList = true;
    if (isArray) obj._meta.isArray = true;
    return appendNodeMeta(obj, valueNode, sourcefile);
}

function createTypeDefinition(node: SyntaxNode | null | undefined, opts: Record<string, any>, aliasName?: SyntaxNode | null): any {
    const sourcefile = opts?.sourcefile as string | undefined;
    if (!node || !['struct_specifier', 'union_specifier', 'enum_specifier'].includes(node.type)) {
        return null;
    }
    const bodyNode = node.childForFieldName('body');
    if (!bodyNode) return null;

    const kind = node.type.replace('_specifier', '');
    const nameNode = node.childForFieldName('name') || aliasName || null;
    const id = cIdentifier(nameNode ? nameNode.text : `anonymous_${kind}`, nameNode || node, sourcefile);
    const body = kind === 'enum'
        ? bodyNode.namedChildren.filter((c) => c.type === 'enumerator').map((e) => {
            const name = e.childForFieldName('name')!;
            const value = e.childForFieldName('value');
            return appendNodeMeta(UAST.variableDeclaration(
                cIdentifier(name.text, name, sourcefile),
                value ? visit(value, opts) : null,
                false,
                primitiveType('int', null, sourcefile)
            ), e, sourcefile);
        })
        : flattenInstructions(visitList(bodyNode.namedChildren, opts));
    const cdef = UAST.classDefinition(id, body, []);
    cdef._meta.kind = kind;
    if (kind !== 'enum') {
        const fields = body.filter((n: any) => UAST.isVariableDeclaration(n)).map((n: any) => n.id.name);
        const structs: Map<string, string[]> | undefined = opts?.__structs;
        if (node.childForFieldName('name')) structs?.set(`${kind} ${node.childForFieldName('name')!.text}`, fields);
        if (aliasName) structs?.set(aliasName.text, fields);
        if (kind === 'union') {
            const unions: Set<string> | undefined = opts?.__unionTypes;
            if (node.childForFieldName('name')) unions?.add(`union ${node.childForFieldName('name')!.text}`);
            if (aliasName) unions?.add(aliasName.text);
        }
    }
    return appendNodeMeta(cdef, node, sourcefile);
}

function createTypedef(node: SyntaxNode, opts: Record<string, any>): any {
    const sourcefile = opts?.sourcefile as string | undefined;
    const typeNode = node.childForFieldName('type');
    const declarators = node.childrenForFieldName('declarator');
    // `typedef struct { ... } T;` names an anonymous struct after the alias.
    const firstAlias = declarators.length ? declaratorName(declarators[0]) : null;
    const typeDefinition = createTypeDefinition(typeNode, opts, firstAlias);
    const structs: Map<string, string[]> | undefined = opts?.__structs;
    const known = structs?.get(typeKey(typeNode) ?? '');
    if (known) for (const d of declarators) { const n = declaratorName(d); if (n) structs!.set(n.text, known); }
    const unions: Set<string> | undefined = opts?.__unionTypes;
    if (unions?.has(typeKey(typeNode) ?? '')) for (const d of declarators) { const n = declaratorName(d); if (n) unions.add(n.text); }
    const aliases = declarators.map((declarator) => {
        const nameNode = declaratorName(declarator);
        const noop = UAST.noop();
        noop._meta.typedef = {
            name: nameNode?.text ?? null,
            type: applyDeclaratorType(mapTypeSpecifier(typeNode, opts), declarator, opts),
        };
        return appendNodeMeta(noop, declarator, sourcefile);
    });
    const all = typeDefinition ? [typeDefinition, ...aliases] : aliases;
    if (all.length === 1) return all[0];
    return appendNodeMeta(UAST.sequence(all), node, sourcefile);
}

function createFunction(node: SyntaxNode, opts: Record<string, any>): UAST.FunctionDefinition {
    const sourcefile = opts?.sourcefile as string | undefined;
    const typeNode = node.childForFieldName('type');
    const declarator = node.childForFieldName('declarator');
    const nameNode = declaratorName(declarator);
    const id = nameNode ? cIdentifier(nameNode.text, nameNode, sourcefile) : null;
    const bodyNode = node.childForFieldName('body');
    const body = bodyNode ? visit(bodyNode, opts) as UAST.Instruction : appendNodeMeta(UAST.scopedStatement([]), node, sourcefile);
    const fdef = UAST.functionDefinition(id, functionParameters(declarator, opts), returnTypeFromFunction(typeNode, declarator || null, opts), body, storageClasses(node));
    return appendNodeMeta(fdef, node, sourcefile);
}

const SIMPLE_ESCAPES: Record<string, string> = {
    n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', f: '\f', v: '\v', e: '\x1b',
    '\\': '\\', "'": "'", '"': '"', '?': '?',
};

/** Decode one C escape sequence, e.g. `\n`, `\x41`, `\101`, `é`. */
function decodeEscape(escape: string): string {
    const body = escape.slice(1);
    if (body in SIMPLE_ESCAPES) return SIMPLE_ESCAPES[body];
    if (/^[0-7]{1,3}$/.test(body)) return String.fromCodePoint(parseInt(body, 8));
    if (/^x[\da-fA-F]+$/.test(body)) return String.fromCodePoint(parseInt(body.slice(1), 16) & 0x10ffff);
    if (/^(u[\da-fA-F]{4}|U[\da-fA-F]{8})$/.test(body)) {
        const code = parseInt(body.slice(1), 16);
        if (code <= 0x10ffff) return String.fromCodePoint(code);
    }
    // Unknown escapes are implementation defined; keep the source text.
    return escape;
}

/** Decoded value of a string_literal or char_literal node. */
function decodeQuoted(node: SyntaxNode): string {
    let value = '';
    for (const child of node.children) {
        if (child.type === 'escape_sequence') value += decodeEscape(child.text);
        else if (child.type === 'string_content' || child.type === 'character') value += child.text;
    }
    return value;
}

function parseIntegerText(text: string): number | string {
    const digits = text.replace(/'/g, '').replace(/[uUlLzZ]+$/, '').replace(/wb$/i, '');
    let big: bigint;
    try {
        if (/^0[xX]/.test(digits)) big = BigInt(digits);
        else if (/^0[bB]/.test(digits)) big = BigInt(digits);
        else if (/^0[0-7]+$/.test(digits)) big = BigInt('0o' + digits.slice(1));
        else if (/^\d+$/.test(digits)) big = BigInt(digits);
        else return text;
    } catch {
        return text;
    }
    // Keep exact source text when JavaScript numbers would lose precision.
    return big <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(big) : digits;
}

function parseNumberText(text: string): number | string {
    const clean = text.replace(/'/g, '');
    const isHex = /^0[xX]/.test(clean);
    const isFloat = isHex ? /[pP]/.test(clean) : /[.eE]/.test(clean);
    if (!isFloat) return parseIntegerText(text);
    if (isHex) {
        const m = clean.replace(/[fFlL]$/, '').match(/^0[xX]([\da-fA-F]*)(?:\.([\da-fA-F]*))?[pP]([+-]?\d+)$/);
        if (!m) return text;
        const mantissa = parseInt((m[1] || '0') + (m[2] || ''), 16) / Math.pow(16, (m[2] || '').length);
        return mantissa * Math.pow(2, Number(m[3]));
    }
    const value = Number(clean.replace(/([fFlL]|[dD][fFdDlL]|f\d+|bf16)$/, ''));
    return Number.isNaN(value) ? text : value;
}

function literalFromText(node: SyntaxNode, sourcefile?: string): UAST.Literal {
    if (node.type === 'string_literal') {
        return appendNodeMeta(UAST.literal(decodeQuoted(node), 'string'), node, sourcefile);
    }
    if (node.type === 'char_literal') {
        const lit = appendNodeMeta(UAST.literal(decodeQuoted(node), 'string'), node, sourcefile);
        lit._meta.charLiteral = true;
        return lit;
    }
    const value = parseNumberText(node.text);
    // Values beyond 2^53 keep their digits, still typed as a number.
    return appendNodeMeta(UAST.literal(value, 'number'), node, sourcefile);
}

/** Adjacent string literals concatenate; macro operands (e.g. PRIu64) become `+` joins. */
function concatenatedString(node: SyntaxNode, opts: Record<string, any>): UAST.Expression {
    const sourcefile = opts?.sourcefile as string | undefined;
    const parts: UAST.Expression[] = [];
    for (const child of node.namedChildren) {
        if (child.type === 'string_literal') {
            const last = parts[parts.length - 1];
            if (last && UAST.isLiteral(last) && typeof last.value === 'string' && !last._meta.macro) {
                last.value += decodeQuoted(child);
                last.loc = { ...last.loc, end: toSourceLocation(child, sourcefile).end } as any;
            } else {
                parts.push(literalFromText(child, sourcefile));
            }
        } else if (child.type !== 'comment') {
            const expr = visit(child, opts) as UAST.Expression;
            expr._meta.macro = true;
            parts.push(expr);
        }
    }
    const joined = parts.reduce((a, b) => appendNodeMeta(UAST.binaryExpression('+', a, b), node, sourcefile));
    return appendNodeMeta(joined, node, sourcefile);
}

/**
 * Coerce a visited node into expression position. GNU statement expressions
 * `({ ... })` and recovered fragments are not UAST expressions; they degrade
 * to a Noop that records what was there.
 */
function asExpression(value: any, node: SyntaxNode | null | undefined, sourcefile?: string): UAST.Expression {
    if (value && UAST.isExpression(value)) return value;
    const noop = UAST.noop();
    if (value) noop._meta.nonExpression = value.type;
    return appendNodeMeta(noop, node || null, sourcefile) as any;
}

function expressionOrNoop(node: SyntaxNode | null | undefined, opts: Record<string, any>): UAST.Expression {
    return asExpression(node ? visit(node, opts) : null, node, opts?.sourcefile);
}

function firstNonComment(node: SyntaxNode): SyntaxNode | null {
    return node.namedChildren.find((c) => c.type !== 'comment') || null;
}

/**
 * #if/#ifdef/#elif/#else: branches the compile configuration excludes are
 * dropped; branches it does not decide are all kept (the analysis covers each
 * configuration), and definitions in them are marked `_meta.conditional`.
 */
function preprocessorConditional(node: SyntaxNode, opts: Record<string, any>): any {
    const sourcefile = opts?.sourcefile as string | undefined;
    const env: MacroEnvironment | undefined = opts.__macroEnv;
    const activity = opts.__macroOffset === undefined ? env?.branchActivity(node.startIndex) : undefined;
    const branch = activity === 'inactive' ? [] : visitStatements(unfieldedNamedChildren(node, ['name', 'condition', 'alternative']), opts);
    if (activity === 'maybe') markConditional(branch);
    const alternative = node.childForFieldName('alternative');
    if (alternative) branch.push(...flattenInstructions([visit(alternative, opts)]));
    if (!branch.length) {
        const noop = UAST.noop();
        noop._meta.preprocessor = { kind: node.type };
        return appendNodeMeta(noop, node, sourcefile);
    }
    const seq = UAST.sequence(branch);
    seq._meta.preprocessor = { kind: node.type };
    return appendNodeMeta(seq, node, sourcefile);
}

function markConditional(items: any[]): void {
    for (const item of items) {
        if (!item || typeof item !== 'object') continue;
        if (item.type === 'Sequence') markConditional(item.expressions || []);
        else if (item.type === 'FunctionDefinition' || item.type === 'VariableDeclaration') item._meta.conditional = true;
    }
}

const STATEMENT_TYPE = /Statement$|^(Sequence|VariableDeclaration|FunctionDefinition|ClassDefinition|Noop)$/;

/**
 * Expand `name` at a use site with every definition that may be in effect
 * there. One possible expansion is returned as is; several (a macro defined
 * differently in configuration-dependent branches, or maybe undefined) are
 * joined by a choice the analysis treats as unknown, so each is analyzed.
 */
function expandAtUseSite(
    name: string,
    node: SyntaxNode,
    opts: Record<string, any>,
    applies: (macro: MacroDefinition) => boolean,
    expand: (macro: MacroDefinition) => any,
    plain: () => any,
): any {
    const env: MacroEnvironment | undefined = opts.__macroEnv;
    if (!env || opts.expandMacros === false || (opts.__expanding as Set<string> | undefined)?.has(name)) return plain();
    const candidates = env.lookup(name, opts.__macroOffset ?? node.startIndex);
    const results: any[] = [];
    let unexpanded = false;
    for (const macro of candidates) {
        const result = macro && applies(macro) ? expand(macro) : null;
        if (result) results.push(result);
        else unexpanded = true;
    }
    if (unexpanded || !results.length) results.push(plain());
    if (results.length === 1) return results[0];
    const sourcefile = opts?.sourcefile as string | undefined;
    const choice = (): any => {
        const id = cIdentifier('__preprocessor_choice__', node, sourcefile);
        id._meta.preprocessorChoice = name;
        return id;
    };
    const asStatement = results.some((r) => STATEMENT_TYPE.test(r.type));
    let combined = results[results.length - 1];
    for (let i = results.length - 2; i >= 0; i--) {
        combined = asStatement
            ? UAST.ifStatement(choice(), results[i], combined)
            : UAST.conditionalExpression(choice(), results[i], combined);
        appendNodeMeta(combined, node, sourcefile);
        combined._meta.macro = name;
    }
    return combined;
}

function relocate(value: any, loc: any, seen = new Set<any>()): void {
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) return value.forEach((v) => relocate(v, loc, seen));
    if (typeof value.type === 'string' && 'loc' in value) {
        value.loc = { ...loc, start: { ...loc.start }, end: { ...loc.end } };
        if (value._meta) value._meta.loc = value.loc;
    }
    for (const [key, child] of Object.entries(value)) {
        if (key !== 'loc' && key !== 'parent') relocate(child, loc, seen);
    }
}

const MACRO_DEPTH_LIMIT = 16;
const UNION_SLOT = '<union>';
/** Complete constructs worth keeping from inside a tree-sitter ERROR region. */
const RECOVERABLE = /(_statement|_definition|^declaration|^preproc_(if|ifdef|elif|elifdef|else|def|function_def|include|call)|^ERROR|^linkage_specification)$/;

/**
 * Expand a macro at its use site: re-parse the replacement text as a
 * statement, visit it with the macro marked as expanding (no self-recursion),
 * and give every resulting node the use site's location. Returns null when
 * the replacement is not a well-formed statement or expression.
 */
function expandMacro(macro: MacroDefinition, text: string, useSite: SyntaxNode, opts: Record<string, any>): any {
    const expanding: Set<string> = opts.__expanding ?? new Set();
    if (expanding.size >= MACRO_DEPTH_LIMIT) return null;
    const tree = getParser().parse(`void __yasa_macro__(void) {\n${text}\n;}`);
    if (!tree) return null;
    try {
        const root = tree.rootNode;
        if (root.hasError) return null;
        const body = root.namedChildren[0]?.childForFieldName('body');
        const statements = (body?.namedChildren ?? []).filter((c) =>
            c.type !== 'comment' && !(c.type === 'expression_statement' && c.namedChildCount === 0));
        if (!statements.length) return null;
        const inner = { ...opts, __expanding: new Set([...expanding, macro.name]), __macroOffset: opts.__macroOffset ?? useSite.startIndex };
        let result: any;
        if (statements.length === 1 && statements[0].type === 'expression_statement') {
            result = visit(namedChild(statements[0], 0), inner);
        } else if (statements.length === 1) {
            result = visit(statements[0], inner);
        } else {
            result = UAST.sequence(visitStatements(statements, inner));
        }
        if (!result) return null;
        relocate(result, toSourceLocation(useSite, opts?.sourcefile));
        result._meta.macro = macro.name;
        return result;
    } finally {
        tree.delete();
    }
}

function caseClause(node: SyntaxNode, opts: Record<string, any>): UAST.CaseClause {
    const sourcefile = opts?.sourcefile as string | undefined;
    const valueNode = node.childForFieldName('value');
    const test = valueNode ? expressionOrNoop(valueNode, opts) : null;
    const body = appendNodeMeta(UAST.scopedStatement(visitStatements(unfieldedNamedChildren(node, ['value']), opts)), node, sourcefile);
    return appendNodeMeta(UAST.caseClause(test, body), node, sourcefile);
}

/**
 * Case labels of a switch body, looking through #if blocks. Statements that
 * are not inside any case (code before the first label, or in a #if branch
 * without labels) attach to the preceding case, or to a leading default-less
 * clause when none exists yet.
 */
function switchCases(body: SyntaxNode, opts: Record<string, any>): UAST.CaseClause[] {
    const cases: UAST.CaseClause[] = [];
    const loose: SyntaxNode[] = [];
    const flush = () => {
        if (!loose.length) return;
        const statements = visitStatements(loose.splice(0), opts);
        if (cases.length) (cases[cases.length - 1].body as any).body.push(...statements);
        else {
            const clause = UAST.caseClause(UAST.noop() as any, UAST.scopedStatement(statements));
            clause._meta.unreachable = true;
            cases.push(clause);
        }
    };
    const collectFrom = (node: SyntaxNode) => {
        for (const child of node.namedChildren) {
            if (child.type === 'case_statement') {
                flush();
                cases.push(caseClause(child, opts));
            } else if (/^preproc_(if|ifdef|elif|elifdef|else)$/.test(child.type)) {
                flush();
                collectFrom(child);
            } else if (child.type !== 'comment' && !(node.type.startsWith('preproc_') && ['name', 'condition', 'alternative'].some((f) => sameNode(node.childForFieldName(f), child)))) {
                loose.push(child);
            }
        }
    };
    collectFrom(body);
    flush();
    return cases;
}

function visit(node: SyntaxNode | null | undefined, opts: Record<string, any>): any {
    if (!node) return null;

    const sourcefile = opts?.sourcefile as string | undefined;

    switch (node.type) {
        case 'translation_unit': {
            const body = visitStatements(node.namedChildren, opts);
            // NOTE: uast-spec 0.2.x 的 compileUnit() 在 builder() 里做运行时校验，
            // language 字段只接受 'javascript'|'typescript'|'java'|'golang'|'python'|'php'，
            // 不认 'c'。因此先传合法值通过运行时校验，再手动修正为 'c'。
            // 待上游 uast-spec 将 'c' 加入合法语言枚举后可移除此 workaround。
            const compileUnit = UAST.compileUnit(body, 'php' as any, 'c11', sourcefile || '', version);
            (compileUnit as any).language = 'c';
            return appendNodeMeta(compileUnit, node, sourcefile);
        }

        case 'comment':
            return null;

        case 'identifier': {
            return expandAtUseSite(
                node.text,
                node,
                opts,
                (macro) => macro.params === null && !!macro.body,
                (macro) => expandMacro(macro, macro.body, node, opts),
                () => cIdentifier(node.text, node, sourcefile),
            );
        }

        case 'field_identifier':
        case 'type_identifier':
        case 'statement_identifier':
        case 'primitive_type':
            return cIdentifier(node.text, node, sourcefile);

        case 'number_literal':
        case 'string_literal':
        case 'char_literal':
            return literalFromText(node, sourcefile);

        case 'concatenated_string':
            return concatenatedString(node, opts);

        case 'true':
        case 'false':
            return appendNodeMeta(UAST.literal(node.type === 'true', 'boolean'), node, sourcefile);

        case 'null':
            return appendNodeMeta(UAST.literal(null, 'null'), node, sourcefile);

        case 'parenthesized_expression':
            return expressionOrNoop(firstNonComment(node), opts);

        case 'expression_statement': {
            const child = namedChild(node, 0);
            if (!child) return appendNodeMeta(UAST.noop(), node, sourcefile);
            const expr = visit(child, opts);
            if (expr && UAST.isNode(expr) && !UAST.isExpression(expr)) return appendNodeMeta(expr, node, sourcefile);
            return appendNodeMeta(UAST.expressionStatement(expr as UAST.Expression), node, sourcefile);
        }

        case 'compound_statement': {
            const body = visitStatements(node.namedChildren, opts);
            return appendNodeMeta(UAST.scopedStatement(body), node, sourcefile);
        }

        case 'function_definition':
            return createFunction(node, opts);

        case 'declaration':
        case 'field_declaration':
            return createDeclaration(node, opts);

        case 'parameter_declaration':
            return createParameter(node, opts);

        case 'type_definition':
            return createTypedef(node, opts);

        case 'linkage_specification':
            return visit(node.childForFieldName('body'), opts);

        case 'declaration_list':
            return appendNodeMeta(UAST.sequence(flattenInstructions(visitList(node.namedChildren, opts))), node, sourcefile);

        case 'preproc_include': {
            const pathNode = node.childForFieldName('path');
            const raw = pathNode ? pathNode.text : '';
            const from = UAST.literal(raw.replace(/^["<]|[">]$/g, ''), 'string');
            appendNodeMeta(from, pathNode || node, sourcefile);
            const imp = UAST.importExpression(from);
            imp._meta.system = raw.startsWith('<');
            return appendNodeMeta(imp, node, sourcefile);
        }

        case 'preproc_if':
        case 'preproc_ifdef':
        case 'preproc_elif':
        case 'preproc_elifdef':
        case 'preproc_else':
            return preprocessorConditional(node, opts);

        case 'preproc_def':
        case 'preproc_function_def': {
            const noop = UAST.noop();
            const params = node.childForFieldName('parameters');
            noop._meta.preprocessor = {
                kind: node.type,
                name: node.childForFieldName('name')?.text ?? null,
                parameters: params ? params.namedChildren.map((p) => p.text) : undefined,
                value: node.childForFieldName('value')?.text ?? null,
            };
            return appendNodeMeta(noop, node, sourcefile);
        }

        case 'preproc_call': {
            const noop = UAST.noop();
            noop._meta.preprocessor = {
                kind: node.type,
                directive: node.childForFieldName('directive')?.text ?? null,
                argument: node.childForFieldName('argument')?.text ?? null,
            };
            return appendNodeMeta(noop, node, sourcefile);
        }

        case 'if_statement': {
            const test = expressionOrNoop(node.childForFieldName('condition'), opts);
            const consequent = visit(node.childForFieldName('consequence'), opts) as UAST.Instruction || UAST.scopedStatement([]);
            const altNode = node.childForFieldName('alternative');
            const alternative = altNode ? visit(altNode, opts) as UAST.Instruction : null;
            return appendNodeMeta(UAST.ifStatement(test, consequent, alternative), node, sourcefile);
        }

        case 'else_clause':
            return visit(namedChild(node, 0), opts);

        case 'for_statement': {
            const initNode = node.childForFieldName('initializer');
            const testNode = node.childForFieldName('condition');
            const updateNode = node.childForFieldName('update');
            const bodyNode = node.childForFieldName('body');
            const init = initNode ? visit(initNode, opts) as UAST.Expression | UAST.VariableDeclaration : null;
            const test = testNode ? visit(testNode, opts) as UAST.Expression : null;
            const update = updateNode ? visit(updateNode, opts) as UAST.Expression : null;
            const body = bodyNode ? visit(bodyNode, opts) as UAST.Instruction : UAST.scopedStatement([]);
            return appendNodeMeta(UAST.forStatement(init, test, update, body), node, sourcefile);
        }

        case 'while_statement': {
            const test = expressionOrNoop(node.childForFieldName('condition'), opts);
            const body = visit(node.childForFieldName('body'), opts) as UAST.Instruction || UAST.scopedStatement([]);
            return appendNodeMeta(UAST.whileStatement(test, body, false), node, sourcefile);
        }

        case 'do_statement': {
            const body = visit(node.childForFieldName('body'), opts) as UAST.Instruction || UAST.scopedStatement([]);
            const test = expressionOrNoop(node.childForFieldName('condition'), opts);
            return appendNodeMeta(UAST.whileStatement(test, body, true), node, sourcefile);
        }

        case 'switch_statement': {
            const discriminant = expressionOrNoop(node.childForFieldName('condition'), opts);
            const bodyNode = node.childForFieldName('body');
            const cases = bodyNode ? switchCases(bodyNode, opts) : [];
            return appendNodeMeta(UAST.switchStatement(discriminant, cases), node, sourcefile);
        }

        case 'case_statement': {
            // A case label outside a switch body (e.g. after error recovery):
            // keep its statements in place.
            const seq = UAST.sequence(visitStatements(unfieldedNamedChildren(node, ['value']), opts));
            seq._meta.caseLabel = node.childForFieldName('value')?.text ?? 'default';
            return appendNodeMeta(seq, node, sourcefile);
        }

        case 'return_statement': {
            const argNode = node.namedChildren.find((c) => c.type !== 'comment');
            const argument = argNode ? visit(argNode, opts) as UAST.Expression : null;
            return appendNodeMeta(UAST.returnStatement(argument), node, sourcefile);
        }

        case 'break_statement':
            return appendNodeMeta(UAST.breakStatement(), node, sourcefile);

        case 'continue_statement':
            return appendNodeMeta(UAST.continueStatement(), node, sourcefile);

        case 'labeled_statement': {
            const labelNode = node.childForFieldName('label');
            const bodyNode = unfieldedNamedChildren(node, ['label']).find((c) => c.type !== 'comment');
            return appendNodeMeta(UAST.labeledStatement(cIdentifier(labelNode ? labelNode.text : '_', labelNode || node, sourcefile), visit(bodyNode, opts) || UAST.noop()), node, sourcefile);
        }

        case 'goto_statement': {
            const noop = UAST.noop();
            noop._meta.goto = node.childForFieldName('label')?.text || null;
            return appendNodeMeta(noop, node, sourcefile);
        }

        case 'binary_expression': {
            const left = expressionOrNoop(node.childForFieldName('left'), opts);
            const right = expressionOrNoop(node.childForFieldName('right'), opts);
            const operator = node.childForFieldName('operator')?.text || getOperator(node);
            return appendNodeMeta(UAST.binaryExpression(operator as any, left, right), node, sourcefile);
        }

        case 'assignment_expression': {
            const left = expressionOrNoop(node.childForFieldName('left'), opts);
            const right = expressionOrNoop(node.childForFieldName('right'), opts);
            const operator = node.childForFieldName('operator')?.text || getOperator(node) || '=';
            return appendNodeMeta(assignment(left, right, operator), node, sourcefile);
        }

        case 'conditional_expression': {
            const test = expressionOrNoop(node.childForFieldName('condition'), opts);
            // GNU `a ?: b` omits the consequence and yields the condition.
            const consequenceNode = node.childForFieldName('consequence');
            const consequent = consequenceNode ? visit(consequenceNode, opts) : expressionOrNoop(node.childForFieldName('condition'), opts);
            const alternative = expressionOrNoop(node.childForFieldName('alternative'), opts);
            return appendNodeMeta(UAST.conditionalExpression(test, consequent, alternative), node, sourcefile);
        }

        case 'unary_expression': {
            const operator = node.childForFieldName('operator')?.text || getOperator(node);
            const argument = expressionOrNoop(node.childForFieldName('argument'), opts);
            return appendNodeMeta(UAST.unaryExpression(operator as any, argument, false), node, sourcefile);
        }

        case 'sizeof_expression':
        case 'alignof_expression': {
            const keyword = node.type === 'sizeof_expression' ? 'sizeof' : node.child(0)!.text;
            const typeNode = node.childForFieldName('type');
            const argument = typeNode
                ? cIdentifier(typeNode.text, typeNode, sourcefile)
                : expressionOrNoop(node.childForFieldName('value'), opts);
            return appendNodeMeta(UAST.callExpression(cIdentifier(keyword, node, sourcefile), [argument]), node, sourcefile);
        }

        case 'offsetof_expression': {
            const typeNode = node.childForFieldName('type');
            const member = node.childForFieldName('member');
            const args = [typeNode && cIdentifier(typeNode.text, typeNode, sourcefile), member && cIdentifier(member.text, member, sourcefile)].filter(Boolean) as UAST.Expression[];
            return appendNodeMeta(UAST.callExpression(cIdentifier('offsetof', node, sourcefile), args), node, sourcefile);
        }

        case 'update_expression': {
            const operator = node.childForFieldName('operator')?.text || getOperator(node) || '++';
            const argumentNode = node.childForFieldName('argument');
            const isSuffix = !!argumentNode && argumentNode.startIndex === node.startIndex;
            return appendNodeMeta(UAST.unaryExpression(operator as any, expressionOrNoop(argumentNode, opts), isSuffix), node, sourcefile);
        }

        case 'pointer_expression': {
            const operator = node.childForFieldName('operator')?.text || getOperator(node);
            const argument = expressionOrNoop(node.childForFieldName('argument'), opts);
            if (operator === '&') return appendNodeMeta(UAST.referenceExpression(argument), node, sourcefile);
            return appendNodeMeta(UAST.dereferenceExpression(argument), node, sourcefile);
        }

        case 'cast_expression': {
            const typeNode = node.childForFieldName('type');
            const valueNode = node.childForFieldName('value');
            return appendNodeMeta(UAST.castExpression(expressionOrNoop(valueNode, opts), mapTypeSpecifier(typeNode, opts)), node, sourcefile);
        }

        case 'compound_literal_expression': {
            const typeNode = node.childForFieldName('type');
            const valueNode = node.childForFieldName('value');
            const cast = UAST.castExpression(expressionOrNoop(valueNode, opts), mapTypeSpecifier(typeNode, opts));
            cast._meta.compoundLiteral = true;
            return appendNodeMeta(cast, node, sourcefile);
        }

        case 'call_expression': {
            const functionNode = node.childForFieldName('function');
            const plainCall = () => {
                const callee = expressionOrNoop(functionNode, opts);
                const argsNode = node.childForFieldName('arguments');
                const args = argsNode
                    ? argsNode.namedChildren.filter((c) => c.type !== 'comment').map((c) => expressionOrNoop(c, opts))
                    : [];
                return appendNodeMeta(UAST.callExpression(callee, args), node, sourcefile);
            };
            if (functionNode?.type !== 'identifier') return plainCall();
            const argTexts = (node.childForFieldName('arguments')?.namedChildren ?? [])
                .filter((c) => c.type !== 'comment')
                .map((c) => c.text);
            return expandAtUseSite(
                functionNode.text,
                node,
                opts,
                (macro) => macro.params !== null,
                (macro) => expandMacro(macro, substitute(macro, argTexts), node, opts),
                plainCall,
            );
        }

        case 'argument_list':
            return appendNodeMeta(UAST.tupleExpression(visitList(node.namedChildren, opts)), node, sourcefile);

        case 'field_expression': {
            const objectNode = node.childForFieldName('argument');
            const object = expressionOrNoop(objectNode, opts);
            let field = expressionOrNoop(node.childForFieldName('field'), opts);
            if (objectNode?.type === 'identifier' && (opts?.__unionVars as Set<string> | undefined)?.has(objectNode.text)) {
                // All members of a union share storage: model them as one slot.
                const member = (field as any).name;
                field = cIdentifier(UNION_SLOT, node.childForFieldName('field'), sourcefile);
                field._meta.member = member;
            }
            const member = UAST.memberAccess(object, field, false);
            member._meta.operator = node.childForFieldName('operator')?.text || (node.text.includes('->') ? '->' : '.');
            return appendNodeMeta(member, node, sourcefile);
        }

        case 'subscript_expression': {
            const object = expressionOrNoop(node.childForFieldName('argument'), opts);
            const index = expressionOrNoop(node.childForFieldName('index'), opts);
            return appendNodeMeta(UAST.memberAccess(object, index, true), node, sourcefile);
        }

        case 'comma_expression': {
            // uast-spec models C's comma operator as a ',' BinaryExpression.
            const left = expressionOrNoop(node.childForFieldName('left'), opts);
            const right = expressionOrNoop(node.childForFieldName('right'), opts);
            return appendNodeMeta(UAST.binaryExpression(',', left, right), node, sourcefile);
        }

        case 'initializer_list': {
            const children = node.namedChildren.filter((c) => c.type !== 'comment');
            if (children.some((c) => c.type === 'initializer_pair')) {
                // Designated initializers are object-like; positional entries get their index as key.
                const properties = children.map((child, index) => {
                    if (child.type !== 'initializer_pair') {
                        return appendNodeMeta(UAST.objectProperty(appendNodeMeta(UAST.literal(index, 'number'), child, sourcefile), visit(child, opts)), child, sourcefile);
                    }
                    const designator = child.childrenForFieldName('designator')[0];
                    const keyNode = designator?.type === 'field_designator' ? namedChild(designator, 0) : designator ? namedChild(designator, 0) : null;
                    const key = keyNode ? visit(keyNode, opts) : appendNodeMeta(UAST.literal(index, 'number'), child, sourcefile);
                    return appendNodeMeta(UAST.objectProperty(key, visit(child.childForFieldName('value'), opts)), child, sourcefile);
                });
                const obj = UAST.objectExpression(properties);
                obj._meta.initializerList = true;
                return appendNodeMeta(obj, node, sourcefile);
            }
            const tuple = UAST.tupleExpression(visitList(children, opts) as Array<UAST.Expression>);
            tuple._meta.initializerList = true;
            return appendNodeMeta(tuple, node, sourcefile);
        }

        case 'struct_specifier':
        case 'union_specifier':
        case 'enum_specifier':
            return createTypeDefinition(node, opts) || appendNodeMeta(UAST.noop(), node, sourcefile);

        case 'empty_statement':
            return appendNodeMeta(UAST.noop(), node, sourcefile);

        case 'attributed_statement': {
            // `__attribute__((fallthrough));` and `[[nodiscard]] stmt`: keep the statement.
            const stmt = node.namedChildren.filter((c) => c.type !== 'attribute_declaration' && c.type !== 'comment').pop();
            return stmt ? visit(stmt, opts) : appendNodeMeta(UAST.noop(), node, sourcefile);
        }

        case 'ERROR': {
            // Keep any complete statements tree-sitter recovered inside the error region.
            const recovered = visitStatements(node.namedChildren.filter((c) => RECOVERABLE.test(c.type)), opts);
            const noop = UAST.noop();
            noop._meta.syntaxError = true;
            appendNodeMeta(noop, node, sourcefile);
            if (!recovered.length) return noop;
            return appendNodeMeta(UAST.sequence([noop, ...recovered]), node, sourcefile);
        }

        default: {
            if (node.namedChildren.length === 1) {
                return visit(node.namedChildren[0], opts);
            }
            const noop = UAST.noop();
            noop._meta.unhandled = { kind: node.type };
            return appendNodeMeta(noop, node, sourcefile);
        }
    }
}

function collectParseErrors(root: SyntaxNode): ParseError[] {
    const errors: ParseError[] = [];
    const cursor = root.walk();
    let descend = true;
    for (;;) {
        const node = cursor.currentNode;
        if (descend && (node.isError || node.isMissing)) {
            errors.push({
                line: node.startPosition.row + 1,
                column: node.startPosition.column + 1,
                kind: node.isMissing ? 'missing' : 'error',
                text: node.isMissing ? node.type : node.text.slice(0, 80),
            });
            descend = false;
        }
        if (descend && node.hasError && cursor.gotoFirstChild()) continue;
        if (cursor.gotoNextSibling()) { descend = true; continue; }
        if (!cursor.gotoParent()) break;
        descend = false;
    }
    cursor.delete();
    return errors;
}

/**
 * Parse C source into a UAST CompileUnit.
 *
 * Tree-sitter recovers from syntax errors (often unexpanded macros), so by
 * default errors are recorded in `_meta.parseErrors` and parsing continues.
 * Pass `{ strict: true }` to throw a SyntaxError instead.
 */
export function parse(content: string, opts: Record<string, any> = {}): UAST.Node {
    const source = content.replace(/^\uFEFF/, '');
    const config: PreprocessorConfig = opts.preprocessor ?? {};
    const env = new MacroEnvironment(source, config, opts.sourcefile);
    // Lines of branches the configuration excludes are blanked, so the tree only holds code that may be compiled.
    const tree = getParser().parse(env.activeSource());
    if (!tree) throw new Error('tree-sitter failed to parse the C source');
    try {
        const root = tree.rootNode;
        const errors = root.hasError ? collectParseErrors(root) : [];
        if (errors.length && opts.strict) {
            const first = errors[0];
            throw new SyntaxError(`C syntax error at ${opts.sourcefile ?? '<source>'}:${first.line}:${first.column}`);
        }
        const unit = visit(root, {
            ...opts,
            __structs: new Map<string, string[]>(),
            __unionTypes: new Set<string>(),
            __unionVars: new Set<string>(),
            __macroEnv: env,
        });
        unit._meta.parseErrors = errors;
        unit._meta.includes = env.includes;
        return unit;
    } finally {
        tree.delete();
    }
}
