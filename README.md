# V WebAssembly playground

Run V programs locally in your browser at <https://vlang.github.io/wasm-playground/>.
Compilation and execution take place in a Web Worker. No compilation server is needed.

This repository contains the static site and generated compiler assets deployed by GitHub Pages.
The playground implementation lives in
[vlang/v](https://github.com/vlang/v/tree/e6634b0d45a25d65683de87337858347337759cb/examples/wasm/playground).

## Supported programs

Try Hello world, Integer loop, or Fibonacci, or edit the source and press Run.
Ctrl+Enter or Cmd+Enter also runs the program. Stop interrupts compilation or execution.

The direct WebAssembly backend currently supports primitive numbers, booleans, functions,
conditionals, loops, and printing string literals or integers. Strings stored in variables,
arrays, maps, structs, and general standard library programs are not yet supported.

The first run downloads the compiler assets. Later runs can reuse the browser's HTTP cache.

## Rebuild and publish

The deployed V source commit is `e6634b0d45a25d65683de87337858347337759cb` (PR #29741).
`build-info.json` records the Emscripten version and the deployed asset hashes.

Follow the upstream
[build instructions](https://github.com/vlang/v/blob/e6634b0d45/examples/wasm/playground/README.md)
at that commit to regenerate the compiler assets.

Copy `index.html`, `playground.js`, `worker.js`, `runtime.mjs`, and the generated
`build/compiler.mjs`, `build/compiler.wasm`, and `build/compiler.data` into this repository.
Update `build-info.json`, retain `.nojekyll`, and push to `main`.
GitHub Pages publishes the root of `main` at the address above.

Before publishing, run the upstream Node runtime tests and check the page in a browser.
