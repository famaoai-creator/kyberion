import { ErrorObject } from 'ajv';
export interface ValidationResult {
    valid: boolean;
    message: string;
    errors?: ErrorObject[] | null;
    schema?: string;
}
export declare function validateData(data: any, schema: any, schemaPath?: string): ValidationResult;
//# sourceMappingURL=lib.d.ts.map