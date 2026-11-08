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

/** UAST without fields that legitimately differ between the C and C++ grammars. */
function comparable(node: any): any {
    return JSON.parse(JSON.stringify(node, (key, value) => {
        if (key === 'parent' || key === 'origin' || key === 'language' || key === 'languageVersion') return undefined;
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
});
