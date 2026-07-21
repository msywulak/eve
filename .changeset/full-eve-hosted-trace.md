---
"eve": patch
---

Prevent hosted functions from shipping an incomplete eve package when an external dependency imports an eve public subpath. Transitively traced eve packages now include their complete runtime closure instead of failing with `ERR_MODULE_NOT_FOUND`.
