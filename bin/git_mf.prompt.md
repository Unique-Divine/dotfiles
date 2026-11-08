# Merge a Branch From origin Into the Current Branch

Bring the current branch up to date with a branch from `origin`, usually
`main`. Work in the repository you were started in. The section at the end
says which branch to merge from, the current branch, and why plain git
stopped. Below, `<base>` means the branch to merge from.

1. Run `git status`. If there are uncommitted changes, keep them: stash them
   with a message, and restore them after the merge. If restoring conflicts,
   stop and report; don't drop the stash.
2. Fetch the base branch from `origin`.
3. If you're on the base branch itself and it has local commits that
   `origin` doesn't, merge `origin/<base>` in. Don't rebase, reset, or force
   anything.
4. Otherwise merge `origin/<base>` into the current branch. A merge commit
   is fine.
5. For each conflict, read both sides and the commits that changed them
   (`git log --merge -p <file>`). Keep what each side was trying to do.
   Picking one side wholesale is only right when the other side's change is
   already covered. If you can't tell what a side meant, stop with the merge
   in progress and report.
6. Run the repository's checks: `just test` when there's a justfile with a
   `test` recipe, otherwise the obvious test command for the repo. Fix
   breakage the merge caused; report breakage that was already there.
7. Commit the merge. Don't push.

Finish with a short report: the new `HEAD`, each file that conflicted and
how you resolved it, the checks you ran and their result, and anything you
left for a person to decide.
