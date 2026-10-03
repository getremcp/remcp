---
name: safe-destructive-operations
description: Use when the primary task is destructive filesystem work on a paired computer: delete/trash, risky overwrite of user data, move/rename with loss risk, or broad replacement that needs a recovery plan. Do not select it for ordinary source-code edits covered by the code-change skill.
---

# Safe destructive operations

ReMCP executes immediately and has no approval prompt, so the care happens here.

On the hosted `remcp.site/mcp` dependency, all filesystem operations named below are `manage_files` operations: call `manage_files` with the named granular operation in `operation` and its original arguments under `parameters`. `list_devices` remains a direct tool. If another compatible host explicitly advertises a granular filesystem tool, use that advertised shape directly.

1. Identify exactly what will be affected. `get_file_info` for every target, plus
   `list_directory` when a glob or a directory is involved, and `hash_file` when you need to
   prove two files are the same.
2. Prefer a reversible step:
   - `move_to_trash` instead of `delete_path` when the user is not certain.
   - `create_archive` of the current state before a bulk rewrite of a directory.
   - `copy_file`/`copy_paths` before an in-place edit of a file you cannot regenerate.
3. Preview every rewrite:
   - `apply_patch` with `dry_run: true`, or `replace_lines`/`edit_block` with `dry_run: true`.
   - `replace_in_files` with `dry_run: true` to see the match count and the files it would touch.
4. Apply only the paths the user named. Never widen a request into a parent directory, a home
   directory, a drive root, a system path or a recursive glob the user did not ask for.
5. Delete in this order: exact files, then the directories that are now empty. Report the exact
   list of removed paths, and confirm afterwards with `list_directory` or `get_file_info`.
6. Stop and ask when a request is ambiguous (two matching paths, a glob that reaches unrelated
   files, a delete inside a repository) or when it would remove something a service is using.

Never delete, overwrite or move: credentials and key material, `.git` directories, the user's
`Documents`/`Desktop`/home root, databases, or anything outside the paths the user named.

Resolve the machine with `list_devices` first and pass its `device` id on every operation.
Honor existing, specific authorization; ask only to resolve missing targets or additional
consequences. Tool annotations do not grant permission or override the host approval rules.
