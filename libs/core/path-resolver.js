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
exports.pathResolver = void 0;
exports.rootDir = rootDir;
exports.knowledge = knowledge;
exports.active = active;
exports.scripts = scripts;
exports.vault = vault;
exports.vision = vision;
exports.shared = shared;
exports.isProtected = isProtected;
exports.skillDir = skillDir;
exports.missionDir = missionDir;
exports.resolve = resolve;
exports.rootResolve = rootResolve;
const path = __importStar(require("node:path"));
const fs = __importStar(require("node:fs"));
/**
 * Path Resolver Utility v4.0 (Protected VFS Edition)
 * Robust directory mapping with metadata for Deep Sandboxing.
 */
function findProjectRoot(startDir) {
    let current = startDir;
    while (current !== path.parse(current).root) {
        if (fs.existsSync(path.join(current, 'package.json')) &&
            (fs.existsSync(path.join(current, 'libs/actuators')) || fs.existsSync(path.join(current, 'knowledge')))) {
            return current;
        }
        current = path.dirname(current);
    }
    return process.cwd();
}
const PROJECT_ROOT_DIR = findProjectRoot(process.cwd());
const ACTIVE_ROOT = path.join(PROJECT_ROOT_DIR, 'active');
const KNOWLEDGE_ROOT = path.join(PROJECT_ROOT_DIR, 'knowledge');
const SCRIPTS_ROOT = path.join(PROJECT_ROOT_DIR, 'scripts');
const VAULT_ROOT = path.join(PROJECT_ROOT_DIR, 'vault');
const VISION_ROOT = path.join(PROJECT_ROOT_DIR, 'vision');
const INDEX_PATH = path.join(KNOWLEDGE_ROOT, 'orchestration/global_skill_index.json');
function rootDir() { return PROJECT_ROOT_DIR; }
function knowledge(subPath = '') { return path.join(KNOWLEDGE_ROOT, subPath); }
function active(subPath = '') { return path.join(ACTIVE_ROOT, subPath); }
function scripts(subPath = '') { return path.join(SCRIPTS_ROOT, subPath); }
function vault(subPath = '') { return path.join(VAULT_ROOT, subPath); }
function vision(subPath = '') { return path.join(VISION_ROOT, subPath); }
function shared(subPath = '') { return path.join(ACTIVE_ROOT, 'shared', subPath); }
function isProtected(filePath) {
    const resolved = path.resolve(filePath);
    if (resolved.startsWith(KNOWLEDGE_ROOT))
        return true;
    if (resolved.startsWith(VAULT_ROOT))
        return true;
    if (resolved.startsWith(VISION_ROOT))
        return true;
    if (resolved.startsWith(SCRIPTS_ROOT) && !resolved.includes('active'))
        return true;
    return false;
}
function skillDir(skillName) {
    if (!fs.existsSync(INDEX_PATH))
        return path.join(PROJECT_ROOT_DIR, 'libs/actuators', skillName);
    const index = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));
    const skillList = index.s || index.skills || [];
    const skill = skillList.find((s) => (s.n || s.name) === skillName);
    if (skill && skill.path)
        return path.join(PROJECT_ROOT_DIR, skill.path);
    // Actuator fallback
    const actuatorPath = path.join(PROJECT_ROOT_DIR, 'libs/actuators', skillName);
    if (fs.existsSync(actuatorPath))
        return actuatorPath;
    return path.join(PROJECT_ROOT_DIR, skillName);
}
function missionDir(missionId) {
    const dir = path.join(ACTIVE_ROOT, 'missions', missionId);
    if (!fs.existsSync(dir))
        fs.mkdirSync(dir, { recursive: true });
    return dir;
}
function resolve(logicalPath) {
    if (!logicalPath)
        return PROJECT_ROOT_DIR;
    if (logicalPath.startsWith('skill://')) {
        const parts = logicalPath.slice(8).split('/');
        return path.join(skillDir(parts[0]), parts.slice(1).join('/'));
    }
    if (logicalPath.startsWith('active/shared/')) {
        return shared(logicalPath.replace('active/shared/', ''));
    }
    return path.isAbsolute(logicalPath) ? logicalPath : path.resolve(PROJECT_ROOT_DIR, logicalPath);
}
function rootResolve(relativePath) {
    return path.isAbsolute(relativePath) ? relativePath : path.join(PROJECT_ROOT_DIR, relativePath);
}
// Named export for older scripts that import * as pathResolver
exports.pathResolver = {
    rootDir: () => PROJECT_ROOT_DIR,
    activeRoot: () => ACTIVE_ROOT,
    knowledgeRoot: () => KNOWLEDGE_ROOT,
    scriptsRoot: () => SCRIPTS_ROOT,
    vaultRoot: () => VAULT_ROOT,
    visionRoot: () => VISION_ROOT,
    knowledge,
    active,
    scripts,
    vault,
    vision,
    shared,
    isProtected,
    skillDir,
    missionDir,
    resolve,
    rootResolve,
};
