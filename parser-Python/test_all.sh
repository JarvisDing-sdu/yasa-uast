#!/usr/bin/env bash
# Run the legacy Python checks and compare the Tree-sitter parser with that oracle.
# Usage: ./test_all.sh
# Optional: PYTHON_UAST_ORACLE=/path/to/python OUTPUT_DIR=/path/to/results ./test_all.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT" || exit 1

PYTHON="${PYTHON_UAST_ORACLE:-$ROOT/.venv313/bin/python3}"
if [[ ! -x "$PYTHON" ]]; then
    PYTHON="$(command -v python3 || true)"
fi
if [[ -z "$PYTHON" ]] || ! "$PYTHON" -c 'import dataclasses_json' >/dev/null 2>&1; then
    echo "Python 依赖不可用。请先在 parser-Python 下安装 requirements.txt，或设置 PYTHON_UAST_ORACLE。" >&2
    exit 2
fi
PYTHON="$("$PYTHON" -c 'import sys; print(sys.executable)')"
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
    echo '需要 Node.js 和 npm。' >&2
    exit 2
fi

OUTPUT_DIR="${OUTPUT_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/yasa-python-tests.XXXXXX")}"
mkdir -p "$OUTPUT_DIR"
OUTPUT_DIR="$(cd "$OUTPUT_DIR" && pwd)"
PASS=0
FAIL=0
SKIP=0

run_step() {
    local label="$1"
    shift
    printf '\n== %s ==\n' "$label"
    if "$@"; then
        printf 'PASS: %s\n' "$label"
        PASS=$((PASS + 1))
        return 0
    else
        printf 'FAIL: %s\n' "$label" >&2
        FAIL=$((FAIL + 1))
        return 1
    fi
}

generate_old_json() {
    PYTHONPATH="$ROOT" "$PYTHON" - "$OUTPUT_DIR" <<'PY'
import json
import sys
from pathlib import Path
from uast.builder import parse_single_file

out = Path(sys.argv[1])
for name in ('test_type_annotations.py', 'example.py', 'import.py'):
    source = Path('test') / name
    target = out / f'{name}.old.json'
    ok, error = parse_single_file(str(source), str(target), verbose=False)
    if not ok:
        raise RuntimeError(f'{source}: {error}')
    target.write_text(json.dumps(json.loads(target.read_text()), ensure_ascii=False, indent=2) + '\n')
    print(f'{source} -> {target}')
PY
}

generate_new_json() {
    node --import tsx --input-type=module - "$OUTPUT_DIR" <<'JS'
import fs from 'node:fs';
import path from 'node:path';
import { Parser } from './src/index.ts';

const out = process.argv[2];
const parser = new Parser();
await parser.init();
for (const name of ['test_type_annotations.py', 'example.py', 'import.py']) {
    const source = path.join('test', name);
    const target = path.join(out, `${name}.new.json`);
    const ast = parser.parse(fs.readFileSync(source, 'utf8'), { sourcefile: source });
    fs.writeFileSync(target, JSON.stringify(ast, null, 2) + '\n');
    console.log(`${source} -> ${target}`);
}
JS
}

compare_json() {
    "$PYTHON" - "$OUTPUT_DIR" <<'PY'
import json
import sys
from pathlib import Path

out = Path(sys.argv[1])
failed = False
for name in ('test_type_annotations.py', 'example.py', 'import.py'):
    old = out / f'{name}.old.json'
    new = out / f'{name}.new.json'
    old_bytes, new_bytes = old.read_bytes(), new.read_bytes()
    if old_bytes == new_bytes:
        print(f'{name}: JSON 原始字节一致')
    else:
        semantic = json.loads(old_bytes) == json.loads(new_bytes)
        print(f'{name}: JSON 原始字节不同；解析后的值相同={semantic}', file=sys.stderr)
        failed = True
sys.exit(1 if failed else 0)
PY
}

run_step 'TypeScript 构建' npm run build || true
run_step '旧版兼容关键字' "$PYTHON" test/test_compat_keywords.py || true
if [[ -f test/test_decorators.py ]]; then
    run_step '旧版装饰器元数据' "$PYTHON" test/test_decorators.py || true
else
    printf 'SKIP: 旧版装饰器元数据（缺少 test/test_decorators.py）\n'
    SKIP=$((SKIP + 1))
fi
if [[ -d test/chatbot_backend && -d test/chatbot_backend_expected ]]; then
    run_step '旧版项目回归' "$PYTHON" test/run_regression.py || true
else
    printf 'SKIP: 旧版项目回归（缺少 chatbot_backend 输入或预期文件）\n'
    SKIP=$((SKIP + 1))
fi
run_step '新版单测和新旧 UAST 逐字段对照' env PYTHON_UAST_ORACLE="$PYTHON" npm test || true

old_ok=0
new_ok=0
run_step '生成旧版 JSON' generate_old_json && old_ok=1
run_step '生成新版 JSON' generate_new_json && new_ok=1
if [[ "$old_ok" -eq 1 && "$new_ok" -eq 1 ]]; then
    run_step '三个样例的 JSON 原始字节对照' compare_json || true
else
    printf 'SKIP: JSON 原始字节对照（生成步骤失败）\n'
    SKIP=$((SKIP + 1))
fi

printf '\n结果：PASS=%s FAIL=%s SKIP=%s\nJSON 文件：%s\n' "$PASS" "$FAIL" "$SKIP" "$OUTPUT_DIR"
if [[ "$FAIL" -gt 0 ]]; then exit 1; fi
