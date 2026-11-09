import type { NodeHandler } from '@ant-yasa/uast-parser-c';
import { internals } from '@ant-yasa/uast-parser-c';
import { cppHandlers } from './index';
import { flatten, IN_FUNCTION } from './common';

const LINKAGE = '__cppLexicalLanguageLinkage';

/** Preserve linkage bodies and pass lexical hints down to their declarations. */
const linkageSpecification: NodeHandler = (node, opts) => {
    const value = node.childForFieldName('value')?.text;
    const linkage = value === '"C"' ? 'C' : value === '"C++"' ? 'C++' : undefined;
    return internals.visit(node.childForFieldName('body'), linkage ? { ...opts, [LINKAGE]: linkage } : opts);
};

/** These are hints only: earlier declarations may determine effective linkage. */
function declarationHandler(kind: string): NodeHandler {
    return (node, opts, next) => {
        const result = cppHandlers[kind](node, opts, next);
        if (opts[IN_FUNCTION]) return result;
        for (const item of flatten([result])) {
            if (item.type !== 'FunctionDefinition' && item.type !== 'VariableDeclaration' && !item._meta?.prototype) continue;
            item._meta.lexicalLanguageLinkage = opts[LINKAGE] ?? 'C++';
            item._meta.languageLinkageExplicit = opts[LINKAGE] !== undefined;
        }
        return result;
    };
}

/** Opt-in only: raw C++ parse keeps the original extension set and metadata. */
export const preprocessedHandlers: Record<string, NodeHandler> = {
    ...cppHandlers,
    linkage_specification: linkageSpecification,
    function_definition: declarationHandler('function_definition'),
    declaration: declarationHandler('declaration'),
};
