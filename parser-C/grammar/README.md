# Vendored C grammar

`grammar.js` is based on tree-sitter-c 0.23.6 (MIT license; see LICENSE). The
local change permits unnamed bit-fields in field declarations. The checked-in
WASM is generated with tree-sitter-cli 0.25.10 and Emscripten 4.0.4. To rebuild,
copy this grammar into a tree-sitter-c 0.23.6 package directory, run
`tree-sitter generate`, then `tree-sitter build --wasm` with Emscripten. Run the
C and C++ parser suites and validate representative Engine dumps after rebuilding.
The original grammar package remains a dependency for reference and upstream
comparison. Changes to the grammar and generated WASM must be reviewed together.
