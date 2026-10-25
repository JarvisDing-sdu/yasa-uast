import 'mocha';
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { init, parse } from '../src/parser';
import { Parser } from '../src';

const unit = (code: string, opts: Record<string, any> = {}): any => parse(code, { sourcefile: 't.c', ...opts });
const body = (code: string): any[] => unit(code).body;
const fnBody = (code: string): any[] => body(code).find((n) => n.type === 'FunctionDefinition').body.body;
const init0 = (code: string): any => body(code)[0].init;

function walk(node: any, visitNode: (n: any) => void) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach((n) => walk(n, visitNode));
    if (node.type) visitNode(node);
    for (const [key, value] of Object.entries(node)) {
        if (key === 'parent' || key === 'loc') continue;
        if (key === '_meta') {
            const typedef = (value as any)?.typedef;
            if (typedef) walk(typedef.type, visitNode);
            continue;
        }
        walk(value, visitNode);
    }
}

function collect(node: any, predicate: (n: any) => boolean): any[] {
    const found: any[] = [];
    walk(node, (n) => predicate(n) && found.push(n));
    return found;
}

describe('parser-C', () => {
    before(async () => {
        await Promise.all([init(), init(), new Parser().init()]);
    });

    describe('compile unit', () => {
        it('produces a C CompileUnit with includes', () => {
            const ast = unit('#include <stdio.h>\n#include "local.h"\nint x;');
            assert.strictEqual(ast.type, 'CompileUnit');
            assert.strictEqual(ast.language, 'c');
            const imports = ast.body.filter((n: any) => n.type === 'ImportExpression');
            assert.deepStrictEqual(imports.map((i: any) => [i.from.value, i._meta.system]), [['stdio.h', true], ['local.h', false]]);
        });

        it('records source locations', () => {
            const decl = body('\n  int value = 1;')[0];
            assert.deepStrictEqual(decl.id.loc.start, { line: 2, column: 7 });
            assert.strictEqual(decl.id.loc.sourcefile, 't.c');
        });

        it('strips a UTF-8 BOM', () => {
            assert.strictEqual(body('\uFEFFint x;')[0].id.name, 'x');
        });

        it('does not store node text in metadata', () => {
            const ast = unit('int f(void) { return 1; }');
            walk(ast, (n) => assert.strictEqual(n._meta?.origin?.text, undefined));
        });
    });

    describe('declarations', () => {
        it('emits exactly one VariableDeclaration per declarator', () => {
            const decls = body('int a, *b = 0, c[3];');
            assert.deepStrictEqual(decls.map((d: any) => d.id.name), ['a', 'b', 'c']);
            assert.deepStrictEqual(decls.map((d: any) => d.varType.type), ['PrimitiveType', 'PointerType', 'ArrayType']);
            assert.strictEqual(body('int x = 1;').length, 1);
        });

        it('ignores storage classes and qualifiers as declarators', () => {
            const decl = body('static const volatile int x = 1;')[0];
            assert.strictEqual(decl.type, 'VariableDeclaration');
            assert.strictEqual(decl.id.name, 'x');
            assert.deepStrictEqual(decl._meta.storage, ['static']);
        });

        it('keeps function prototypes out of variable scope', () => {
            const [proto, fn] = body('char *get(int n);\nchar *get(int n) { return 0; }');
            assert.strictEqual(proto.type, 'Noop');
            assert.strictEqual(proto._meta.prototype, 'get');
            assert.strictEqual(fn.type, 'FunctionDefinition');
        });

        it('reads declarators inside-out', () => {
            const arrOfPtr = body('char *xs[4];')[0].varType;
            assert.deepStrictEqual([arrOfPtr.type, arrOfPtr.element.type], ['ArrayType', 'PointerType']);
            const ptrToArr = body('char (*p)[4];')[0].varType;
            assert.deepStrictEqual([ptrToArr.type, ptrToArr.element.type], ['PointerType', 'ArrayType']);
            const grid = body('int g[2][3];')[0].varType;
            assert.deepStrictEqual([grid.type, grid.element.type, grid.element.element.type], ['ArrayType', 'ArrayType', 'PrimitiveType']);
        });

        it('treats function pointer declarations as variables', () => {
            const decl = body('void (*handler)(int) = 0;')[0];
            assert.strictEqual(decl.type, 'VariableDeclaration');
            assert.strictEqual(decl.id.name, 'handler');
            assert.strictEqual(decl.varType.type, 'PointerType');
            assert.strictEqual(decl.varType.element.type, 'FuncType');
        });

        it('maps struct, union and enum definitions to ClassDefinition', () => {
            const [st, un, en] = body('struct S { int a; char *b; };\nunion U { int i; float f; };\nenum E { A, B = 5 };');
            assert.deepStrictEqual([st.type, st.id.name, st._meta.kind], ['ClassDefinition', 'S', 'struct']);
            assert.deepStrictEqual(st.body.map((f: any) => f.id.name), ['a', 'b']);
            assert.strictEqual(un._meta.kind, 'union');
            assert.deepStrictEqual(en.body.map((e: any) => [e.id.name, e.init?.value ?? null]), [['A', null], ['B', 5]]);
        });

        it('defines a struct and a variable in one declaration', () => {
            const [def, variable] = body('struct P { int x; } origin = { 0 };');
            assert.strictEqual(def.type, 'ClassDefinition');
            assert.strictEqual(variable.id.name, 'origin');
            assert.strictEqual(variable.varType.type, 'ScopedType');
        });

        it('models union members as one storage slot', () => {
            const stmts = fnBody('typedef union { char *a; char *b; } U;\nvoid f(char *x) { U u; u.a = x; g(u.b); }');
            assert.strictEqual(stmts[1].expression.left.property.name, '<union>');
            assert.strictEqual(stmts[2].expression.arguments[0].property.name, '<union>');
            assert.strictEqual(stmts[2].expression.arguments[0].property._meta.member, 'b');
            const plain = fnBody('struct S { char *a; char *b; };\nvoid f(char *x) { struct S s; s.a = x; }');
            assert.strictEqual(plain[1].expression.left.property.name, 'a');
        });

        it('handles typedefs including anonymous structs', () => {
            const [def, alias] = body('typedef struct { int a; } T;');
            assert.strictEqual(def.type, 'ClassDefinition');
            assert.strictEqual(def.id.name, 'T');
            assert.strictEqual(alias._meta.typedef.name, 'T');
            const plain = body('typedef unsigned long size_type;')[0];
            assert.strictEqual(plain._meta.typedef.name, 'size_type');
            assert.strictEqual(plain._meta.typedef.type.id.name, 'unsigned long');
            const fp = body('typedef int (*cmp)(const void *, const void *);')[0];
            assert.strictEqual(fp._meta.typedef.name, 'cmp');
            assert.strictEqual(fp._meta.typedef.type.type, 'PointerType');
        });
    });

    describe('functions', () => {
        it('maps name, parameters, return type and body', () => {
            const fn = body('static char *dup(const char *s, int n) { return 0; }')[0];
            assert.strictEqual(fn.id.name, 'dup');
            assert.deepStrictEqual(fn.parameters.map((p: any) => [p.id.name, p.varType.type, p._meta.isParameter]), [
                ['s', 'PointerType', true],
                ['n', 'PrimitiveType', true],
            ]);
            assert.strictEqual(fn.returnType.type, 'PointerType');
            assert.deepStrictEqual(fn.modifiers, ['static']);
            assert.strictEqual(fn.body.body[0].type, 'ReturnStatement');
        });

        it('treats (void) as no parameters and keeps unnamed parameters', () => {
            assert.strictEqual(body('int f(void) { return 0; }')[0].parameters.length, 0);
            const proto = body('int g(int, char *) { return 0; }')[0];
            assert.deepStrictEqual(proto.parameters.map((p: any) => p._meta.unnamed), [true, true]);
        });

        it('parses main with argv', () => {
            const fn = body('int main(int argc, char **argv) { return 0; }')[0];
            assert.deepStrictEqual(fn.parameters.map((p: any) => p.id.name), ['argc', 'argv']);
            assert.strictEqual(fn.parameters[1].varType.element.type, 'PointerType');
        });
    });

    describe('statements', () => {
        it('maps if/else, loops, switch and jumps', () => {
            const stmts = fnBody(`void f(int n) {
                if (n) { n--; } else if (n > 2) n++; else {}
                for (int i = 0; i < n; i++) continue;
                while (n) break;
                do { n--; } while (n > 0);
                switch (n) { case 1: n = 2; break; default: n = 3; }
                label: n = 0;
                goto label;
            }`);
            assert.deepStrictEqual(stmts.map((s: any) => s.type), [
                'IfStatement', 'ForStatement', 'WhileStatement', 'WhileStatement',
                'SwitchStatement', 'LabeledStatement', 'Noop',
            ]);
            assert.strictEqual(stmts[0].alternative.type, 'IfStatement');
            assert.strictEqual(stmts[1].init.type, 'VariableDeclaration');
            assert.strictEqual(stmts[3].isPostTest, true);
            assert.deepStrictEqual(stmts[4].cases.map((c: any) => [c.test?.value ?? null, c.body.body.length]), [[1, 2], [null, 1]]);
            assert.strictEqual(stmts[6]._meta.goto, 'label');
        });
    });

    describe('expressions', () => {
        it('maps operators', () => {
            const stmts = fnBody('void f(int a, int b) { a += b << 2; a = !b; a = b++; a = ++b; a = b ? a : 0; a = (b, 3); }');
            const rights = stmts.map((s: any) => s.expression);
            assert.strictEqual(rights[0].operator, '+=');
            assert.strictEqual(rights[0].right.operator, '<<');
            assert.strictEqual(rights[1].right.operator, '!');
            assert.deepStrictEqual([rights[2].right.operator, rights[2].right.isSuffix], ['++', true]);
            assert.deepStrictEqual([rights[3].right.operator, rights[3].right.isSuffix], ['++', false]);
            assert.strictEqual(rights[4].right.type, 'ConditionalExpression');
            assert.deepStrictEqual([rights[5].right.type, rights[5].right.operator], ['BinaryExpression', ',']);
        });

        it('maps pointers, members, subscripts, casts and calls', () => {
            const stmts = fnBody('void f(struct S *s, int *p, int xs[]) { p = &xs[1]; *p = s->v + s[0].w; g((char *)p, sizeof(int), sizeof *p); }');
            const [addr, deref, call] = stmts.map((s: any) => s.expression);
            assert.strictEqual(addr.right.type, 'ReferenceExpression');
            assert.strictEqual(addr.right.argument.computed, true);
            assert.strictEqual(deref.left.type, 'DereferenceExpression');
            assert.deepStrictEqual([deref.right.left.property.name, deref.right.left._meta.operator], ['v', '->']);
            assert.strictEqual(deref.right.right._meta.operator, '.');
            assert.strictEqual(call.callee.name, 'g');
            assert.strictEqual(call.arguments[0].type, 'CastExpression');
            assert.deepStrictEqual(call.arguments.slice(1).map((a: any) => [a.callee.name, a.arguments[0].type]), [
                ['sizeof', 'Identifier'],
                ['sizeof', 'DereferenceExpression'],
            ]);
        });

        it('maps initializer lists, designated initializers and compound literals', () => {
            const xs = init0('int xs[] = {1, 2};');
            assert.deepStrictEqual([xs.type, xs._meta.isArray], ['ObjectExpression', true]);
            assert.deepStrictEqual(xs.properties.map((p: any) => [p.key.value, p.value.value]), [[0, 1], [1, 2]]);
            const designated = init0('struct P p = { .x = 1, .y = v };');
            assert.strictEqual(designated.type, 'ObjectExpression');
            assert.deepStrictEqual(designated.properties.map((p: any) => p.key.name), ['x', 'y']);
            assert.strictEqual(designated.properties[1].value.name, 'v');
            const sparse = init0('char *xs[4] = { [2] = a, b };');
            assert.deepStrictEqual(sparse.properties.map((p: any) => [p.key.value, p.value.name]), [[2, 'a'], [3, 'b']]);
            const grid = init0('int g[2][2] = { {1, 2}, {3, 4} };');
            assert.strictEqual(grid.properties[1].value.properties[0].value.value, 3);
            const [, positional] = body('struct Q { char *a; char *b; };\nstruct Q q = { x, y };');
            assert.deepStrictEqual(positional.init.properties.map((p: any) => [p.key.name, p.value.name]), [['a', 'x'], ['b', 'y']]);
            const aliased = body('typedef struct { int n; char *s; } R;\nR r = { 1, s };');
            assert.deepStrictEqual(aliased[2].init.properties.map((p: any) => p.key.name), ['n', 's']);
            assert.strictEqual(init0('struct Unknown u = { x, y };').type, 'TupleExpression');
            const literal = init0('struct P *p = &(struct P){ 1, 2 };');
            assert.strictEqual(literal.argument.type, 'CastExpression');
            assert.strictEqual(literal.argument._meta.compoundLiteral, true);
        });
    });

    describe('robustness', () => {
        it('assigns through pointers', () => {
            const stmt = fnBody('void f(int *p, int v) { *p = v; *(p + 1) += v; }');
            assert.strictEqual(stmt[0].expression.left.type, 'DereferenceExpression');
            assert.strictEqual(stmt[1].expression.operator, '+=');
        });

        it('finds case labels nested in #if blocks', () => {
            const sw = fnBody('void f(int n) { switch (n) {\n#ifdef A\n case 1: a(); break;\n#endif\n case 2: b(); } }')[0];
            assert.deepStrictEqual(sw.cases.map((c: any) => c.test.value), [1, 2]);
        });

        it('degrades GNU statement expressions and comments in conditions', () => {
            const stmts = fnBody('void f(int x) { g(({ int y = x; y; })); while (x /* c */) x--; }');
            assert.strictEqual(stmts[0].expression.arguments[0]._meta.nonExpression, 'ScopedStatement');
            assert.strictEqual(stmts[1].test.name, 'x');
        });

        it('keeps the rest of a file when one statement cannot be built', () => {
            const ast = unit('int a;\nint b;');
            assert.deepStrictEqual(ast.body.map((n: any) => n.id.name), ['a', 'b']);
        });
    });

    describe('literals', () => {
        const values: Array<[string, any]> = [
            ['42', 42], ['0x1F', 31], ['0XffUL', 255], ['010', 8], ['0', 0], ['0b101', 5],
            ['1.5f', 1.5], ['1e-3', 0.001], ['.5', 0.5], ['0x1p4', 16], ['10u', 10], ['1000000LL', 1000000],
            ['18446744073709551615ULL', '18446744073709551615'],
        ];
        for (const [text, expected] of values) {
            it(`number ${text}`, () => {
                const lit = init0(`long double v = ${text};`);
                assert.strictEqual(lit.literalType, 'number');
                assert.strictEqual(lit.value, expected);
            });
        }

        it('decodes string and char escapes', () => {
            assert.strictEqual(init0(String.raw`char *s = "a\n\t\"\\\x41\101\0";`).value, 'a\n\t"\\AA\0');
            assert.strictEqual(init0(String.raw`char c = '\n';`).value, '\n');
            assert.strictEqual(init0(`char c = 'x';`)._meta.charLiteral, true);
            assert.strictEqual(init0(String.raw`wchar_t *w = L"\u00e9";`).value, 'é');
        });

        it('concatenates adjacent strings and keeps macro pieces', () => {
            assert.strictEqual(init0('char *s = "ab" "c" "d";').value, 'abcd');
            const joined = init0('char *s = "n=%" PRIu64 "\\n";');
            assert.strictEqual(joined.type, 'BinaryExpression');
            assert.strictEqual(joined.left.right.name, 'PRIu64');
            assert.strictEqual(joined.right.value, '\n');
        });
    });

    describe('preprocessor', () => {
        it('keeps code inside header guards', () => {
            const ast = body('#ifndef H\n#define H\nvoid f(char *p) { system(p); }\n#endif\n');
            assert.ok(collect(ast, (n) => n.type === 'FunctionDefinition' && n.id.name === 'f').length === 1);
        });

        it('keeps every #if/#elif/#else branch', () => {
            const ast = body('#if A\nint a;\n#elif B\nint b;\n#else\nint c;\n#endif\n');
            assert.deepStrictEqual(collect(ast, (n) => n.type === 'VariableDeclaration').map((d) => d.id.name), ['a', 'b', 'c']);
            const stmts = fnBody('void f() {\n#ifdef X\n x();\n#else\n y();\n#endif\n}');
            assert.deepStrictEqual(collect(stmts, (n) => n.type === 'CallExpression').map((c) => c.callee.name), ['x', 'y']);
        });

        it('records macro definitions', () => {
            const [obj, fn] = body('#define SIZE 16\n#define MAX(a, b) ((a) > (b) ? (a) : (b))\n');
            assert.deepStrictEqual(obj._meta.preprocessor, { kind: 'preproc_def', name: 'SIZE', parameters: undefined, value: '16' });
            assert.deepStrictEqual(fn._meta.preprocessor.parameters, ['a', 'b']);
        });

        it('expands object-like and function-like macros', () => {
            const stmts = fnBody(`#define CMD_ARG data
#define EXEC execl
#define RUN(x) system(x)
#define LOG(fmt, ...) printf(fmt, __VA_ARGS__)
void f(char *data) { EXEC("/bin/sh", CMD_ARG, 0); RUN(data); LOG("%s", data, 1); }`);
            const [exec, run, log] = stmts.map((s: any) => s.expression);
            assert.deepStrictEqual([exec.callee.name, exec.arguments[1].name], ['execl', 'data']);
            assert.deepStrictEqual([run.callee.name, run.arguments[0].name, run._meta.macro], ['system', 'data', 'RUN']);
            assert.deepStrictEqual(log.arguments.map((a: any) => a.name ?? a.value), ['%s', 'data', 1]);
            assert.strictEqual(run.loc.start.line, 5);
        });

        it('prefers portable macro definitions over Windows-only ones', () => {
            const stmts = fnBody(`#ifdef _WIN32
#define EXECL _execl
#else
#define EXECL execl
#endif
#ifndef _WIN32
#define SH "/bin/sh"
#else
#define SH "cmd.exe"
#endif
void f(void) { EXECL(SH, 0); }`);
            assert.strictEqual(stmts[0].expression.callee.name, 'execl');
            assert.strictEqual(stmts[0].expression.arguments[0].value, '/bin/sh');
        });

        it('handles stringify, token pasting, statement macros and recursion', () => {
            const stmts = fnBody(`#define STR(x) #x
#define CAT(a, b) a ## b
#define SAFE_FREE(p) do { free(p); p = 0; } while (0)
#define SELF SELF
void f(char *buf) { g(STR(hello), CAT(my, var)); SAFE_FREE(buf); h(SELF); }`);
            const call = stmts[0].expression;
            assert.deepStrictEqual([call.arguments[0].value, call.arguments[1].name], ['hello', 'myvar']);
            assert.strictEqual(stmts[1].type, 'WhileStatement');
            assert.strictEqual(stmts[2].expression.arguments[0].name, 'SELF');
        });

        it('keeps macros whose replacement is not a complete statement', () => {
            const stmts = fnBody('#define BEGIN {\nvoid f(void) { g(BEGIN); }');
            assert.strictEqual(stmts[0].expression.arguments[0].name, 'BEGIN');
            assert.strictEqual(unit('#define X 1\nint y = X;', { expandMacros: false }).body[1].init.name, 'X');
        });

        it('unwraps extern "C"-style blocks', () => {
            assert.ok(collect(body('extern "C" { int f(void) { return 0; } }'), (n) => n.type === 'FunctionDefinition').length === 1);
        });
    });

    describe('syntax errors', () => {
        it('records errors and keeps recovered code', () => {
            const ast = unit('int ok(void) { return 1; }\nint broken( { return 0 }\n');
            assert.ok(ast._meta.parseErrors.length > 0);
            assert.ok(collect(ast, (n) => n.type === 'FunctionDefinition' && n.id?.name === 'ok').length === 1);
            assert.deepStrictEqual(unit('int x;')._meta.parseErrors, []);
        });

        it('throws in strict mode', () => {
            assert.throws(() => unit('int main( { return 0 }', { strict: true }), SyntaxError);
        });
    });

    describe('fixtures', () => {
        it('parses vulnerable.c without unhandled nodes', () => {
            const code = fs.readFileSync(path.join(__dirname, 'fixtures', 'vulnerable.c'), 'utf8');
            const ast = unit(code, { sourcefile: 'vulnerable.c' });
            assert.deepStrictEqual(ast._meta.parseErrors, []);
            assert.deepStrictEqual(collect(ast, (n) => n._meta?.unhandled), []);
            const calls = new Set(collect(ast, (n) => n.type === 'CallExpression').map((c) => c.callee.name));
            for (const name of ['getenv', 'system', 'fgets', 'printf', 'recv', 'memcpy', 'execl']) assert.ok(calls.has(name), name);
            assert.deepStrictEqual(collect(ast, (n) => n.type === 'FunctionDefinition').map((f) => f.id.name), [
                'test_command_injection', 'test_format_string', 'test_buffer_overflow', 'test_exec_family', 'main',
            ]);
        });
    });
});
