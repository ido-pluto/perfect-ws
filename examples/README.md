# PerfectWS Examples

This directory contains examples demonstrating various features of PerfectWS.

## Examples

### Zod Validation Example

**File:** `zod-validation-example.ts`

Demonstrates how to use the built-in Zod validation middleware for request validation.

**Features shown:**
- Basic schema validation with `validateWithZod()`
- Query parameter validation with `validateQueryWithZod()`
- Custom error messages and error codes
- Complex nested object validation
- Integration with global middleware
- Multiple validation schemas

**Prerequisites:**
```bash
npm install zod
```

**Topics covered:**
- User creation with validation
- User updates with partial schemas
- Query parameters with defaults
- Complex order data validation
- Error handling

## Running Examples

These examples are TypeScript files that demonstrate API usage. They are meant to be read and adapted to your needs rather than run directly.

To use these patterns in your application:

1. Copy the relevant code
2. Adapt it to your data models
3. Add your business logic
4. Test with your WebSocket clients

## Additional Resources

- [Main README](../README.md) - Complete documentation
- [Tests](../tests/) - More usage examples
- [Source Code](../src/) - Implementation details

