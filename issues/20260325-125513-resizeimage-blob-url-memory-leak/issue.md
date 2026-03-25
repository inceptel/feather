# Bug: resizeImage() leaks blob URL on every image attach

## Status
new

## Severity
medium

## Steps to reproduce
1. Open any session on Feather
2. Attach an image file via the file picker, drag-and-drop, or clipboard paste
3. Repeat multiple times

## Expected behavior
Each `URL.createObjectURL()` call should have a matching `URL.revokeObjectURL()` after the image loads, freeing the blob URL from memory.

## Actual behavior
`resizeImage()` at `App.tsx:23` creates a blob URL via `URL.createObjectURL(blob)` to load the image into an `<img>` element for resizing. After `img.onload` fires and the canvas resize is complete, the blob URL is never revoked. Each image attachment leaks one blob URL.

### Code path
```
addFiles() (line 59) → resizeImage(f) (line 11-25) → URL.createObjectURL(blob) (line 23)
```

The blob URL is assigned to `img.src` and used only during the synchronous `onload` handler. After `onload` completes, the blob URL is no longer needed but remains allocated.

### Impact
- Each leaked blob URL holds a reference to the entire original image blob in memory
- For a 5MB photo, each attachment leaks ~5MB
- Users who attach many images in a session will see increasing memory consumption
- Memory is only freed when the entire page/tab is closed

### Fix
Add `URL.revokeObjectURL(img.src)` inside the `img.onload` handler, after the canvas operations complete:

```javascript
img.onload = () => {
  URL.revokeObjectURL(img.src)  // ← add this line
  const { width: w, height: h } = img
  // ... rest of handler
}
```

## Screenshots
N/A — code-level bug, not visual

## Environment
- File: frontend/src/App.tsx, line 11-25
- Browser: All (standard Web API behavior)
