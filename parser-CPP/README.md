# @ant-yasa/uast-parser-cpp

Converts C++ source code into YASA UAST.

The parser loads `tree-sitter-cpp.wasm` and reuses the parser-C visitor
(`@ant-yasa/uast-parser-c`) through its extension point: the C++ grammar is a
superset of the C grammar, so C constructs are handled by parser-C and C++ node
types by the handlers in `src/handlers/`. Preprocessing is parser-C's
`MacroEnvironment`, with `__cplusplus` predefined as `201703L`.

## Usage

```ts
import { Parser } from '@ant-yasa/uast-parser-cpp';

const parser = new Parser({ sourcefile: 'example.cpp' });
await parser.init();
const ast = parser.parse('namespace n { int f() { return 1; } }');
```

Options are those of parser-C (`sourcefile`, `strict`, `expandMacros`, `preprocessor`).

## Development

parser-C must be built first (`cd ../parser-C && npm ci && npm run build`).

```bash
npm install
npm test
npm run build
```
