# ScratchASM

A Scratch-style block editor that compiles to **x86-64 NASM**, assembles it with `nasm`,
links it with `ld` into a real **Linux ELF executable**, and runs it, all on your own machine.

No libc, no runtime: the generated program talks to the kernel with raw `syscall`s.

```
blocks in the browser  ->  NASM source  ->  nasm -f elf64  ->  ld  ->  ./program (ELF)
      (public/)          (compiler.js)        (server.js runs these and the result)
```

## Requirements

* Node.js 18+
* `nasm` and `ld` (binutils)
* An x86-64 **Linux** machine (or WSL2, or Docker; see below)

```bash
# Debian / Ubuntu / WSL2
sudo apt install nasm binutils
# Fedora
sudo dnf install nasm binutils
# Arch
sudo pacman -S nasm binutils
```

## Run it

```bash
npm install
npm start
# open http://localhost:3000
```

Options (environment variables):

| Variable | Default | Meaning |
|----------|---------|---------|
| `PORT` / `HOST` | 3000 / 127.0.0.1 | where to listen |
| `DATA_DIR` | `./data` | accounts and saved projects (`db.json`) |
| `ALLOW_REGISTRATION` | on | set `0` to stop new accounts |
| `DISABLE_RUN` | off | set `1` for assemble/download only |
| `RUN_REQUIRES_LOGIN` | off | set `1` so only signed-in users can Run |
| `RUN_TIMEOUT_MS` | 5000 | kill programs after this long |

### macOS, Windows, or ARM machines: Docker

ELF binaries only run on Linux, so use the container (it has NASM and ld inside):

```bash
docker build --platform linux/amd64 -t scratchasm .
docker run --rm --platform linux/amd64 -p 127.0.0.1:3000:3000 -v scratchasm-data:/data scratchasm
```

On Apple Silicon this runs under emulation, which is fine for this workload.
On Windows you can also just use WSL2 and follow the normal steps.

## Modes, themes, accounts

* **Blocks | Code** switch (top left). *Blocks* is the Scratch-style editor. *Code* is a blank
  NASM file (starting with the ScratchASM watermark) with highlighting, line numbers, Tab
  indent and auto-indent. Each mode keeps its own document.
* **Code files are never run on the website.** Run only accepts a block project, which the
  server compiles itself; it refuses assembly text. In Code mode use **Assemble** (checks it
  builds, errors are marked in the gutter) and **Download ELF**, then run it yourself.
  *File > Edit this program as code* copies a block program's NASM into Code mode.
* **Theme** button cycles Auto / Light / Dark (remembered).
* **Accounts**: username + password, saved on the server (`data/db.json`, passwords hashed
  with scrypt, HttpOnly SameSite=Strict session cookie, login throttling). *File > Save*
  (Ctrl+S), *My projects...*, *Save a copy*. There is no password recovery. *Export/Import*
  still work for plain files (.json for blocks, .asm for code).

## Using it

1. Pick a category on the left, then **drag blocks** into the workspace.
2. Every program starts with **when program starts**. Scripts without a hat block are ignored.
3. Drag reporters (round) and booleans (hexagonal) into the matching slots.
4. Press **Run** (or Ctrl/Cmd+Enter). Output appears on the right; the **NASM** tab shows the
   generated assembly live as you edit; the **Input** tab feeds stdin to "read number" blocks.
5. **Download ELF** gives you the linked executable: `chmod +x program.elf && ./program.elf`.
6. Right-click a block for Duplicate / Delete. Drop blocks on the palette to delete them.
   **Save** / **Open** store projects as `.json`; your work also auto-saves in the browser.

### What the blocks do

| Category  | Blocks |
|-----------|--------|
| Events    | when program starts |
| Control   | repeat, forever, if, if/else, while, repeat until, break out of loop, exit with code |
| Output    | print text (supports `\n`, `\t`, `\\`), print number, print byte, print newline |
| Input     | read number from stdin into a variable |
| Operators | `+ - * /`, mod, pick random, `< > = != <= >=`, and, or, not |
| Variables | Make a Variable, set, change, variable reporters |
| My Blocks | Make a Block (a procedure), call |
| Assembly  | raw NASM line (copied verbatim), comment |

All numbers are signed 64-bit integers. Division by zero gives 0. Custom blocks take no
arguments: pass data with variables (they are globals, so recursion works but shares them).

### Mixing in real assembly

The **asm** block drops one line of NASM straight into your program, e.g. `mov rax, 1`.
Helpers you can `call` from it: `rt_print_int` (prints the signed integer in `rax`) and
`rt_print_char` (prints the byte in `al`); a helper is only included in the output once a
normal block that uses it exists. Conventions: expression results are in `rax`, and
variables are 64-bit slots named `v_<name>` (e.g. `mov rax, [v_counter]`).

## Project layout

```
server.js            Express backend: /api/run, /api/download, /api/status
public/
  index.html, style.css
  blocks.js          block definitions (shared)
  compiler.js        blocks -> NASM
  editor.js          palette, workspace, drag & drop
  samples.js         example programs
  app.js             UI wiring, run/stop/save/open, NASM highlighting
test/smoke.mjs       compiles + assembles + runs every example
test/api.mjs         accounts, saved projects, run rules, origin checks (live server)
store.js, accounts.js  JSON-file storage, sessions, saved-project API
```

`npm test` needs `nasm` and `ld` and checks that every example produces the expected output.

## Security: please read

This app **assembles and executes machine code sent to it**; that is the whole point, and
an `asm` block (or a loaded project file) can do anything your user account can do. So:

* The server binds to `127.0.0.1` only, rejects requests whose `Host` is not localhost, and
  rejects cross-origin requests, so other websites can't drive it from your browser.
* Programs run with an empty environment, a 5 s timeout, and a 1 MiB output cap.
  There is **no sandbox** beyond that. Don't expose this to a network, and don't open
  project files from people you don't trust without looking at the NASM tab first.
* Accounts make it tempting to share this. Don't put it on a network unless you trust every
  user: a block project can contain a raw `asm` block, so anyone who can Run can execute code
  as the server's user. For a shared server use Docker plus `DISABLE_RUN=1` (assemble only) or
  `RUN_REQUIRES_LOGIN=1` with `ALLOW_REGISTRATION=0`.
* NASM directives that read server files (`%include`, `incbin`, `%!`, ...) are refused.
* The Docker setup adds a container boundary and is the safer way to run it.

## Known limits

* Integers only (no floats, lists or strings-as-values); `print text` is literal text.
* `INT64_MIN / -1` raises a CPU exception (SIGFPE), as on real hardware.
* "print byte" writes a raw byte, not a UTF-8 code point.
