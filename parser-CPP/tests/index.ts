import 'mocha';
import * as assert from 'assert';
import { Parser } from '../src';
import { Parser as CParser } from '@ant-yasa/uast-parser-c';

describe('parser-CPP preprocessed input', () => {
    const parser = new Parser({ sourcefile: 'prepared.cpp', languageVersion: 'c++20', preprocessor: { defines: { VALUE: '99' } } });
    before(async () => { await parser.init(); });

    it('retains class and class-template member bodies and their scope', () => {
        const ast: any = parser.parsePreprocessed('namespace N { template<class T> class Box { public: T get(){ return T(); } template<class U> U convert(U x){ return x; } }; }', { strict: true });
        const [box] = collect(ast, n => n.type === 'ClassDefinition');
        assert.strictEqual(box.id.name, 'Box');
        assert.strictEqual(box._meta.cppTemplate.parameters, '<class T>');
        assert.strictEqual(box._meta.qualifiedName, 'N::Box');
        const functions = collect(box, n => n.type === 'FunctionDefinition');
        assert.deepStrictEqual(functions.map(n => n.id.name), ['get', 'convert']);
        assert.strictEqual(functions[1]._meta.cppTemplate.parameters, '<class U>');
        assert.strictEqual(functions[0]._meta.qualifiedName, 'N::Box::get');
        assert.strictEqual(collect(box, n => n._meta?.cppAccess === 'public').length, 1);
    });

    it('retains embedded and nested class definitions alongside object declarations', () => {
        const ast: any = parser.parsePreprocessed('class Outer { class Inner { int value(){ return 1; } }; }; class Item { int get(){ return 2; } } item;', { strict: true });
        assert.deepStrictEqual(collect(ast, n => n.type === 'ClassDefinition').map(n => n.id.name), ['Outer', 'Inner', 'Item']);
        assert.deepStrictEqual(collect(ast, n => n.type === 'FunctionDefinition').map(n => n.id.name), ['value', 'get']);
        assert.ok(collect(ast, n => n.type === 'VariableDeclaration' && n.id.name === 'item').length);
    });

    it('preserves member names for out-of-line class-template methods and operators', () => {
        const ast: any = parser.parsePreprocessed('template<class T> class Box { public: T get(); }; template<class T> T Box<T>::get(){ return T(); } class C { public: C() {} ~C() {} int operator()(int x){ return x; } };', { strict: true });
        const functions = collect(ast, n => n.type === 'FunctionDefinition');
        assert.deepStrictEqual(functions.map(n => n.id.name), ['get', 'C', '~C', 'operator()']);
        assert.strictEqual(functions[0]._meta.qualifiedName, 'Box<T>::get');
    });

    it('retains range-loop initialization, element references and body calls', () => {
        const ast: any = parser.parsePreprocessed('void f(){ for(auto values=make(); const auto &value: values) sink(value); }', { strict: true });
        const [loop] = collect(ast, n => n.type === 'RangeStatement');
        assert.strictEqual(loop.value.id.name, 'value');
        assert.strictEqual(loop.value._meta.reference, 'lvalue');
        assert.strictEqual(loop.right.name, 'values');
        assert.deepStrictEqual(collect(ast, n => n.type === 'CallExpression').map(n => n.callee.name), ['make', 'sink']);
    });

    it('retains try bodies, typed handlers, catch-all handlers and rethrows', () => {
        const ast: any = parser.parsePreprocessed('void f(){ try { sink(); } catch(const Error &error) { handle(error); throw; } catch(...) { fallback(); } }', { strict: true });
        const [statement] = collect(ast, n => n.type === 'TryStatement');
        assert.strictEqual(statement.handlers.length, 2);
        assert.strictEqual(statement.handlers[0].parameter[0].id.name, 'error');
        assert.strictEqual(statement.handlers[1]._meta.cppCatchAll, true);
        assert.deepStrictEqual(collect(ast, n => n.type === 'CallExpression').map(n => n.callee.name), ['sink', 'handle', 'fallback']);
        assert.strictEqual(collect(ast, n => n.type === 'ThrowStatement')[0].argument, null);
    });

    it('retains reference-returning template bodies, default parameters and parameter packs', () => {
        const ast: any = parser.parsePreprocessed('class C { template<class... Args> C &add(int value = 2, Args &&...args){ sink(value); return *this; } };', { strict: true });
        const [fn] = collect(ast, n => n.type === 'FunctionDefinition');
        assert.strictEqual(fn.id.name, 'add');
        assert.strictEqual(fn._meta.cppReturnReference, 'lvalue');
        assert.strictEqual(fn.parameters.length, 2);
        assert.strictEqual(fn.parameters[0].init.value, 2);
        assert.strictEqual(fn.parameters[1]._meta.cppParameterPack, true);
        assert.strictEqual(fn.parameters[1]._meta.reference, 'rvalue');
        assert.strictEqual(collect(fn, n => n.type === 'CallExpression')[0].callee.name, 'sink');
    });

    it('supports C and C++ through one package with per-call language isolation', async () => {
        const unified = new Parser({ language: 'c', sourcefile: 'unit.c' });
        await unified.init();
        const code = '#ifdef __cplusplus\nint cpp_only;\n#else\nstruct S { unsigned :3, value:2; };\n#endif';
        const c: any = unified.parse(code);
        assert.strictEqual(c.language, 'c');
        assert.deepStrictEqual(c._meta.parseErrors, []);
        assert.strictEqual(collect(c, n => n.type === 'ClassDefinition')[0].id.name, 'S');
        const cpp: any = unified.parse(code, { language: 'cpp' });
        assert.strictEqual(cpp.language, 'cpp');
        assert.strictEqual(collect(cpp, n => n.type === 'VariableDeclaration')[0].id.name, 'cpp_only');
        const prepared: any = unified.parsePreprocessed('int f(void){ return 1; }');
        assert.strictEqual(prepared.language, 'c');
        assert.strictEqual(unified.parse(code).language, 'c');
        assert.throws(() => unified.parse('int x;', { language: 'rust' }), /Unsupported parser language/);
    });

    it('preserves diagnostic-looking text inside multiline C++ raw strings', () => {
        const code = 'const char *text = R"tag(\n#pragma clang diagnostic push\n__signed__\n)tag";';
        const ast: any = parser.parsePreprocessed(code, { strict: true });
        assert.strictEqual(ast._meta.diagnosticPragmas, undefined);
        assert.strictEqual(collect(ast, n => n.type === 'VariableDeclaration')[0].init.value, '\n#pragma clang diagnostic push\n__signed__\n');
    });

    it('accepts GCC signed type spelling without changing C++ raw strings', () => {
        const ast: any = parser.parsePreprocessed('typedef __signed__ char s8;\nconst char *s = R"tag(\"__signed__\")tag";', { strict: true });
        assert.deepStrictEqual(ast._meta.parseErrors, []);
        assert.strictEqual(collect(ast, n => n.type === 'VariableDeclaration')[0].init.value, '"__signed__"');
    });

    it('does not expand caller macros or redefine compiler-undefined platform identifiers', () => {
        const ast: any = parser.parsePreprocessed('#define RUN(a, b, c) replacement(a, b, c)\nint f(int linux, int __cplusplus) { return RUN(VALUE, linux, __cplusplus); }', {
            expandMacros: true, preprocessor: { defines: { VALUE: '42', RUN: 'replacement' } },
        });
        const [call] = collect(ast, n => n.type === 'CallExpression');
        assert.strictEqual(call.callee.name, 'RUN');
        assert.deepStrictEqual(call.arguments.map((n: any) => n.name), ['VALUE', 'linux', '__cplusplus']);
        assert.deepStrictEqual(ast._meta.parseErrors, []);
        assert.deepStrictEqual(collect(ast, n => !!n._meta?.macro), []);
    });

    it('skips branch selection and source macro definitions', () => {
        const ast = parser.parsePreprocessed('#define VALUE 9\n#ifdef __cplusplus\nint one;\n#else\nint two;\n#endif\nint f() { return VALUE; }', {
            preprocessed: false, preprocessor: { unknownMacros: 'undefined' },
        });
        assert.deepStrictEqual(collect(ast, n => n.type === 'VariableDeclaration').map(n => n.id.name), ['one', 'two']);
        assert.strictEqual(collect(ast, n => n.type === 'ReturnStatement')[0].argument.name, 'VALUE');
    });

    it('never inspects caller preprocessor overrides', () => {
        const ast: any = parser.parsePreprocessed('int system(const char *command);', {
            preprocessor: new Proxy({}, { get() { throw new Error('preprocessor must not be read'); } }),
        });
        assert.strictEqual(ast.body[0]._meta.prototype, 'system');
        assert.deepStrictEqual(ast._meta.includes, []);
    });

    it('preserves namespace, qualified calls, references and raw strings', () => {
        const ast: any = parser.parsePreprocessed('namespace A::B { void f(int &x) { const char *s = R"tag(a\\nb\nlinux)tag"; std::system(s); } }', { strict: true });
        const [fn] = collect(ast, n => n.type === 'FunctionDefinition');
        assert.strictEqual(fn._meta.qualifiedName, 'A::B::f');
        assert.strictEqual(fn.parameters[0]._meta.reference, 'lvalue');
        assert.strictEqual(collect(ast, n => n.type === 'VariableDeclaration' && n.id.name === 's')[0].init.value, 'a\\nb\nlinux');
        const [call] = collect(ast, n => n.type === 'CallExpression');
        assert.strictEqual(call.callee._meta.qualifier, 'std');
        assert.strictEqual(call.callee._meta.namespaceContext, 'A::B');
        assert.deepStrictEqual(ast._meta.parseErrors, []);
    });

    it('preserves caller languageVersion, sourcefile, CRLF positions and defaults', () => {
        const ast: any = parser.parsePreprocessed('\r\n\r\n  int f() {\r\n    return linux;\r\n  }\r\n', {
            sourcefile: 'generated/header.ii', languageVersion: 'c++23', strict: true,
        });
        assert.strictEqual(ast.language, 'cpp');
        assert.strictEqual(ast.languageVersion, 'c++23');
        const [id] = collect(ast, n => n.type === 'Identifier' && n.name === 'linux');
        assert.deepStrictEqual(id.loc.start, { line: 4, column: 12 });
        assert.strictEqual(id.loc.sourcefile, 'generated/header.ii');
        assert.strictEqual((parser.parsePreprocessed('int x;') as any).languageVersion, 'c++20');
        assert.strictEqual((cpp.parsePreprocessed('int x;') as any).languageVersion, 'c++17');
    });

    it('preserves strict errors and recovery', () => {
        const code = 'int broken( { return 0 }';
        assert.throws(() => parser.parsePreprocessed(code, { strict: true, sourcefile: 'broken.ii' }),
            (e: any) => e instanceof SyntaxError && e.message.includes('broken.ii:'));
        assert.ok((parser.parsePreprocessed(code) as any)._meta.parseErrors.length > 0);
    });

    it('retains extern C blocks and single declarations inside namespaces', () => {
        const ast: any = parser.parsePreprocessed('namespace N { extern "C" { int f() { return system("x"); } int prototype(); extern int value; } extern "C" int g() { return 2; } extern "C" int single(); int plain() { return 3; } }', { strict: true });
        assert.deepStrictEqual(collect(ast, n => n.type === 'FunctionDefinition').map(n => n.id.name), ['f', 'g', 'plain']);
        const [fn] = collect(ast, n => n.type === 'FunctionDefinition' && n.id.name === 'f');
        assert.strictEqual(fn._meta.qualifiedName, 'N::f');
        assert.strictEqual(fn._meta.lexicalLanguageLinkage, 'C');
        assert.strictEqual(fn._meta.languageLinkageExplicit, true);
        assert.strictEqual(fn._meta.languageLinkage, undefined);
        const declarations = collect(ast, n => n._meta?.prototype || (n.type === 'VariableDeclaration' && n.id.name === 'value'));
        assert.deepStrictEqual(declarations.map(n => n._meta.prototype ?? n.id.name), ['prototype', 'value', 'single']);
        for (const decl of declarations) {
            assert.strictEqual(decl._meta.lexicalLanguageLinkage, 'C');
            assert.strictEqual(decl._meta.namespace, 'N');
        }
        assert.strictEqual(collect(ast, n => n.type === 'CallExpression')[0].callee.name, 'system');
    });

    it('restores lexical linkage after nested specifications and does not leak to raw parse', () => {
        const code = 'extern "C" { int a(); extern "C++" { int b(); } int c(); } int d();';
        const before = JSON.stringify(parser.parse(code));
        const ast = parser.parsePreprocessed(code, { strict: true });
        const declarations = collect(ast, n => !!n._meta?.prototype);
        assert.deepStrictEqual(declarations.map(n => [n._meta.prototype, n._meta.lexicalLanguageLinkage, n._meta.languageLinkageExplicit]), [
            ['a', 'C', true], ['b', 'C++', true], ['c', 'C', true], ['d', 'C++', false],
        ]);
        assert.strictEqual(JSON.stringify(parser.parse(code)), before);
        assert.strictEqual(collect(parser.parse('int f() { return VALUE; }'), n => n.type === 'ReturnStatement')[0].argument.value, 99);
        assert.strictEqual(collect(parser.parsePreprocessed('int f() { return VALUE; }'), n => n.type === 'ReturnStatement')[0].argument.name, 'VALUE');
    });
});

const cpp = new Parser({ sourcefile: 't.cpp' });
const c = new CParser({ sourcefile: 't.cpp' });

function walk(node: any, visitNode: (n: any) => void) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach((n) => walk(n, visitNode));
    if (node.type) visitNode(node);
    for (const [key, value] of Object.entries(node)) {
        if (key === 'parent' || key === 'loc' || key === '_meta') continue;
        walk(value, visitNode);
    }
}

function collect(node: any, predicate: (n: any) => boolean): any[] {
    const found: any[] = [];
    walk(node, (n) => predicate(n) && found.push(n));
    return found;
}

/** UAST without fields that legitimately differ between the C and C++ parsers (C++ adds namespace context). */
function comparable(node: any): any {
    return JSON.parse(JSON.stringify(node, (key, value) => {
        if (['parent', 'origin', 'language', 'languageVersion', 'namespaceContext'].includes(key)) return undefined;
        return value;
    }));
}

describe('parser-CPP', () => {
    before(async () => {
        await Promise.all([cpp.init(), c.init()]);
    });

    describe('compile unit', () => {
        for (const [name, code] of [
            ['arithmetic and return', 'int add(int a, int b) { return a + b; }'],
            ['pointer read and write', 'void set(int *p) { *p = 3; }'],
            ['array indexing', 'int get(int *a, int i) { return a[i]; }'],
            ['loop and conditional', 'int f(int n) { int s = 0; for (int i = 0; i < n; i++) { if (i > 1) s += i; } return s; }'],
            ['structure member access', 'struct S { int n; }; int f(struct S *p) { return p->n; }'],
            ['function pointer call', 'int apply(int (*fn)(int), int x) { return fn(x); }'],
        ]) {
            it(`matches C UAST for common syntax: ${name}`, () => {
                const cAst: any = c.parse(code, { strict: true });
                const cppAst: any = cpp.parse(code, { strict: true });
                assert.deepStrictEqual(comparable(cppAst), comparable(cAst));
            });
        }
        it('parses the C subset like parser-C', () => {
            const code = [
                'struct S { char *p; int n; };',
                'int helper(int x) { return x + 1; }',
                'int f(struct S *s, char *in) {',
                '    char *q = in;',
                '    s->p = q;',
                '    if (s->n > 0) { return helper(s->n); }',
                '    return system(s->p);',
                '}',
            ].join('\n');
            assert.deepStrictEqual(comparable(cpp.parse(code)), comparable(c.parse(code)));
        });

        it('marks the compile unit as cpp', () => {
            const unit: any = cpp.parse('int x;');
            assert.strictEqual(unit.language, 'cpp');
        });

        it('defines __cplusplus', () => {
            const unit: any = cpp.parse('#ifdef __cplusplus\nint in_cpp(void) { return 1; }\n#else\nint in_c(void) { return 0; }\n#endif\n');
            const names = collect(unit, (n) => n.type === 'FunctionDefinition').map((f) => f.id.name);
            assert.deepStrictEqual(names, ['in_cpp']);
        });
    });

    describe('namespaces', () => {
        const fns = (code: string) => collect(cpp.parse(code), (n) => n.type === 'FunctionDefinition');
        const calls = (code: string) => collect(cpp.parse(code), (n) => n.type === 'CallExpression');

        it('retains namespace ownership on function prototypes', () => {
            const unit: any = cpp.parse('namespace X { namespace std { int system(const char *); } }');
            const [prototype] = collect(unit, (n) => n._meta?.prototype === 'system');
            assert.strictEqual(prototype._meta.namespace, 'X::std');
            assert.strictEqual(prototype._meta.qualifiedName, 'X::std::system');
        });

        it('encodes functions inside nested namespaces', () => {
            const unit: any = cpp.parse('namespace A { namespace B { int f(void) { return 1; } int g; } }\nnamespace C::D { void h() {} }\nint top(void) { return 0; }');
            const byName = Object.fromEntries(collect(unit, (n) => n.type === 'FunctionDefinition').map((f) => [f.id.name, f._meta]));
            assert.strictEqual(byName.f.namespace, 'A::B');
            assert.strictEqual(byName.f.qualifiedName, 'A::B::f');
            assert.strictEqual(byName.h.qualifiedName, 'C::D::h');
            assert.strictEqual(byName.top.namespace, undefined);
            const g = collect(unit, (n) => n.type === 'VariableDeclaration' && n.id.name === 'g')[0];
            assert.strictEqual(g._meta.qualifiedName, 'A::B::g');
        });

        it('encodes functions defined with a qualified name outside their namespace', () => {
            const [k] = fns('void A::B::k() {}');
            assert.strictEqual(k.id.name, 'k');
            assert.strictEqual(k._meta.qualifiedName, 'A::B::k');
        });

        it('keeps members of an anonymous namespace in the enclosing namespace', () => {
            const [hidden] = fns('namespace A { namespace { void hidden() {} } }');
            assert.strictEqual(hidden._meta.qualifiedName, 'A::hidden');
            assert.strictEqual(hidden._meta.anonymousNamespace, true);
        });

        it('encodes qualified calls including std::', () => {
            const [system, f, g] = calls('void h(char *x) { std::system(x); A::B::f(); ::g(); }');
            assert.deepStrictEqual([system.callee.name, system.callee._meta.qualifier], ['system', 'std']);
            assert.deepStrictEqual([f.callee.name, f.callee._meta.qualifier], ['f', 'A::B']);
            assert.deepStrictEqual([g.callee.name, g.callee._meta.qualifier], ['g', '']);
        });

        it('records namespace context on unqualified identifiers', () => {
            const [inner, outer] = calls('namespace A { void bad(char *d) { run(d); } }\nvoid top(char *d) { run(d); }');
            assert.strictEqual(inner.callee._meta.namespaceContext, 'A');
            assert.strictEqual(inner.arguments[0]._meta.namespaceContext, 'A');
            assert.strictEqual(outer.callee._meta.namespaceContext, '');
        });

        it('records using directives and declarations', () => {
            const unit: any = cpp.parse('namespace N { using namespace A; }\nusing A::B::f;');
            const usings = collect(unit, (n) => n.type === 'Noop' && (n._meta.usingNamespace || n._meta.usingDeclaration));
            assert.deepStrictEqual(usings.map((u) => [u._meta.usingNamespace, u._meta.usingDeclaration, u._meta.namespaceContext]), [
                ['A', undefined, 'N'],
                [undefined, 'A::B::f', ''],
            ]);
        });

        it('expands a macro containing a qualified name', () => {
            const [call] = calls('#define RUN std::system\nvoid f(char *c) { RUN(c); }');
            assert.deepStrictEqual([call.callee.name, call.callee._meta.qualifier], ['system', 'std']);
        });
    });

    describe('statements and expressions', () => {
        const fnBody = (code: string): any[] => collect(cpp.parse(code), (n) => n.type === 'FunctionDefinition')[0].body.body;

        it('preserves nested and expression subscript indices', () => {
            const ast = cpp.parse('int f(int **a, int i) { return a[i + 1][0]; }', { strict: true });
            const [outer, inner] = collect(ast, n => n.type === 'MemberAccess' && n.computed);
            assert.strictEqual(outer.property.value, 0);
            assert.strictEqual(inner.property.type, 'BinaryExpression');
            assert.strictEqual(inner.property.left.name, 'i');
            assert.strictEqual(inner.property.right.value, 1);
        });

        it('preserves all arguments of a C++23 multidimensional subscript', () => {
            const ast = cpp.parse('int f(A a, int i, int j) { return a[i, j]; }', { strict: true });
            const [access] = collect(ast, n => n.type === 'MemberAccess' && n.computed);
            assert.strictEqual(access.property.type, 'TupleExpression');
            assert.deepStrictEqual(access.property.elements.map((n: any) => n.name), ['i', 'j']);
        });

        it('maps condition_clause with and without init statement', () => {
            const [plain] = fnBody('void f(int x) { if (x) g(); }');
            assert.strictEqual(plain.type, 'IfStatement');
            assert.strictEqual(plain.test.name, 'x');

            const [withInit] = fnBody('void f() { if (char *d = getenv("X"); d) system(d); }');
            assert.strictEqual(withInit.type, 'ScopedStatement');
            assert.deepStrictEqual(withInit.body.map((s: any) => s.type), ['VariableDeclaration', 'IfStatement']);
            assert.strictEqual(withInit.body[0].init.callee.name, 'getenv');
            assert.strictEqual(withInit.body[1].test.name, 'd');

            const [declared] = fnBody('void f() { if (char *d = getenv("X")) system(d); }');
            assert.deepStrictEqual(declared.body.map((s: any) => s.type), ['VariableDeclaration', 'IfStatement']);
            assert.strictEqual(declared.body[1].test.name, 'd');
        });

        it('maps nullptr and C++ casts', () => {
            const [a, b, c] = fnBody('void f(void *v) { char *p = nullptr; char *q = static_cast<char *>(v); long n = reinterpret_cast<long>(q); }');
            assert.strictEqual(a.init.type, 'Literal');
            assert.strictEqual(a.init.value, null);
            assert.strictEqual(b.init.type, 'CastExpression');
            assert.strictEqual(b.init.expression.name, 'v');
            assert.strictEqual(c.init.type, 'CastExpression');
            assert.strictEqual(c.init.expression.name, 'q');
        });

        it('marks reference parameters and variables', () => {
            const [f] = collect(cpp.parse('void f(int &x, char *&p, int &&m, int plain) { int &r = x; char * &dataRef = p; int v = x; }'),
                (n) => n.type === 'FunctionDefinition');
            assert.deepStrictEqual(f.parameters.map((p: any) => [p.id.name, p._meta.reference]),
                [['x', 'lvalue'], ['p', 'lvalue'], ['m', 'rvalue'], ['plain', undefined]]);
            assert.deepStrictEqual(f.body.body.map((d: any) => [d.id.name, d._meta.reference]),
                [['r', 'lvalue'], ['dataRef', 'lvalue'], ['v', undefined]]);
        });

        it('keeps functions around unparseable template code', () => {
            const unit: any = cpp.parse('int a(void) { return 1; }\ntemplate <typename T> T bad(T x) { return x <<>> ; }\nint b(void) { return 2; }');
            const names = collect(unit, (n) => n.type === 'FunctionDefinition').map((f) => f.id.name);
            assert.ok(names.includes('a') && names.includes('b'), names.join(','));
            assert.ok(unit._meta.parseErrors.length > 0);
        });
    });

    it('preserves a function template and its body without inventing specializations', () => {
        const ast = cpp.parse('namespace N { template <typename T> T twice(T x) { return x + x; } }', { strict: true });
        const [fn] = collect(ast, n => n.type === 'FunctionDefinition');
        assert.strictEqual(fn.id.name, 'twice');
        assert.strictEqual(fn._meta.qualifiedName, 'N::twice');
        assert.strictEqual(fn._meta.cppTemplate.parameters, '<typename T>');
        assert.strictEqual(collect(fn, n => n.type === 'ReturnStatement').length, 1);
    });

    it('keeps unsupported template specializations explicit instead of misnaming them', () => {
        const ast = cpp.parse('template <> int twice<int>(int x) { return x; }', { strict: true });
        assert.strictEqual(collect(ast, n => n.type === 'FunctionDefinition').length, 0);
        assert.strictEqual(collect(ast, n => n._meta?.unhandled?.kind === 'template_declaration').length, 1);
    });

    it('preserves qualified and member template calls', () => {
        const ast = cpp.parse('void f() { std::make_shared<Item>(1); object.run<int>(2); }', { strict: true });
        const [first, second] = collect(ast, n => n.type === 'CallExpression');
        assert.strictEqual(first.callee.name, 'make_shared');
        assert.strictEqual(first.callee._meta.qualifier, 'std');
        assert.strictEqual(first.callee._meta.cppTemplateArguments, '<Item>');
        assert.strictEqual(second.callee.property.name, 'run');
        assert.strictEqual(second.callee.property._meta.cppTemplateArguments, '<int>');
    });

    it('preserves the this expression in an out-of-class member definition', () => {
        const ast = cpp.parse('void A::set(int value) { this->value = value; }', { strict: true });
        const [member] = collect(ast, n => n.type === 'MemberAccess');
        assert.strictEqual(member.object.type, 'ThisExpression');
        assert.strictEqual(member.property.name, 'value');
        assert.strictEqual(member._meta.operator, '->');
    });

    it('records simple using type aliases and pointer targets', () => {
        const ast = cpp.parse('using Index = int; using Ptr = int *;', { strict: true });
        const aliases = collect(ast, n => !!n._meta?.typedef).map(n => n._meta.typedef);
        assert.deepStrictEqual(aliases.map((n: any) => n.name), ['Index', 'Ptr']);
        assert.strictEqual(aliases[0].type.type, 'PrimitiveType');
        assert.strictEqual(aliases[1].type.type, 'PointerType');
    });

    it('keeps namespace context for a using type alias', () => {
        const ast = cpp.parse('namespace N { using Index = int; }', { strict: true });
        const [alias] = collect(ast, n => n._meta?.typedef?.name === 'Index');
        assert.strictEqual(alias._meta.namespace, 'N');
    });

    it('preserves a directive-looking line and comment text inside a raw string', () => {
        const code = 'const char *s = R"tag(\n#define VALUE /* keep */ 1\n)tag";\nint f() { return VALUE; }';
        const ast = cpp.parse(code, { strict: true });
        const [decl] = collect(ast, n => n.type === 'VariableDeclaration');
        assert.strictEqual(decl.init.value, '\n#define VALUE /* keep */ 1\n');
        const [ret] = collect(ast, n => n.type === 'ReturnStatement');
        assert.strictEqual(ret.argument.type, 'Identifier');
        assert.strictEqual(ret.argument.name, 'VALUE');
    });
});


describe('M1 review parser regressions', () => {
    before(async () => { await cpp.init(); });
    it('retains namespace context and absolute qualification on qualified identifiers', () => {
        const calls = collect(cpp.parse('namespace X { void f(){ B::g(); ::g(); } }'), n => n.type === 'CallExpression');
        assert.strictEqual(calls[0].callee._meta.namespaceContext, 'X');
        assert.strictEqual(calls[0].callee._meta.globalQualified, false);
        assert.strictEqual(calls[1].callee._meta.globalQualified, true);
    });
    it('visits out-of-line namespace function bodies in their owning namespace', () => {
        const calls = collect(cpp.parse('namespace X { void f(); } void X::f(){ g(); }'), n => n.type === 'CallExpression');
        assert.strictEqual(calls[0].callee._meta.namespaceContext, 'X');
    });
    it('evaluates a while condition declaration inside the loop test', () => {
        const loops = collect(cpp.parse('void f(){ while(char *p = next()) use(p); }'), n => n.type === 'WhileStatement');
        assert.strictEqual(loops[0].test.type, 'Sequence');
        assert.strictEqual(loops[0].test.expressions[0].type, 'VariableDeclaration');
        assert.strictEqual(loops[0].test.expressions[0].init?.callee?.name, 'next');
        assert.strictEqual(loops[0].test.expressions[1].name, 'p');
    });
    it('keeps raw string contents without decoding backslashes or custom delimiters', () => {
        const d: any = cpp.parse('void f(){const char *s=R"tag(a\\nb)tag"; const char *t=R"()";}');
        const decls = collect(d, n => n.type === 'VariableDeclaration');
        assert.strictEqual(decls[0].init.type, 'Literal');
        assert.strictEqual(decls[0].init.value, 'a\\nb');
        assert.strictEqual(decls[1].init.value, '');
    });
});
