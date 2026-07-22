# Example: Documentation Task

This example demonstrates a documentation update task.

## Task
Update the README to document the new `timeout` parameter for the `calculateTotal` function.

## Before
```javascript
// Calculates the total price of all items
export function calculateTotal(items) {
```

## After
```javascript
// Calculates the total price of all items
// @param {Array} items - Array of item objects with price field
// @param {number} [timeout] - Optional timeout in ms for async operations
// @returns {number} Total price
export function calculateTotal(items, timeout) {
```

## Verification
- Check that the function signature matches the documentation
- Run any related tests
- Verify no broken links in the updated docs