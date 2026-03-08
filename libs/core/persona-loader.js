"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.personaLoader = void 0;
const fs = __importStar(require("node:fs"));
/**
 * Persona Loader Utility
 * Extracts role definitions from knowledge/personalities/matrix.md
 */
exports.personaLoader = {
    loadPersonas: (matrixPath) => {
        if (!fs.existsSync(matrixPath))
            return {};
        const content = fs.readFileSync(matrixPath, 'utf8');
        const personas = {};
        const sections = content.split(/^## /m);
        sections.forEach((section) => {
            const lines = section.split('\n');
            const titleLine = lines[0];
            const nameMatch = titleLine.match(/^\d+\.\s+(.+?)\s+\(/) || titleLine.match(/^\d+\.\s+(.+)/);
            if (nameMatch) {
                const name = nameMatch[1].trim();
                const roleLine = lines.find((l) => l.includes('- **役割**'));
                const viewpointLine = lines.find((l) => l.includes('- **視点**'));
                const toneLine = lines.find((l) => l.includes('- **口調**'));
                personas[name] = {
                    role: roleLine ? roleLine.replace('- **役割**:', '').trim() : '',
                    viewpoint: viewpointLine ? viewpointLine.replace('- **視点**:', '').trim() : '',
                    tone: toneLine ? toneLine.replace('- **口調**:', '').trim() : '',
                };
            }
        });
        return personas;
    },
};
//# sourceMappingURL=persona-loader.js.map