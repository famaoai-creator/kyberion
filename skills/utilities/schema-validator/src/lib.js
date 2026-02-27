"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateData = validateData;
const ajv_1 = __importDefault(require("ajv"));
const ajv = new ajv_1.default({ allErrors: true });
function validateData(data, schema, schemaPath) {
    const validate = ajv.compile(schema);
    const valid = validate(data);
    if (valid) {
        return { valid: true, message: 'Validation successful', schema: schemaPath };
    }
    else {
        return { valid: false, message: 'Validation failed', errors: validate.errors };
    }
}
//# sourceMappingURL=lib.js.map