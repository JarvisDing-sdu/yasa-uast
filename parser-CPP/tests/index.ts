import 'mocha';
import * as assert from 'assert';
import { Parser } from '../src';
import { Parser as CParser } from '@ant-yasa/uast-parser-c';

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
