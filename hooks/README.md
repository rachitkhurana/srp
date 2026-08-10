# hooks/

Your own plan and hook files go here. Everything in this directory is git-ignored
except this README, so you can keep as many throwaway files as you like without
them ever showing up in `git status`.

```bash
srp --plan hooks/my-page.cjs
srp https://my-site.com 20 --script hooks/dismiss-banner.cjs --pause 40%:2
```

For the shapes these files can take, copy one out of [`../examples/`](../examples/):

- `basic.hooks.cjs` is the smallest `--script` file (a `before` and an `after`).
- `basic.plan.cjs` is the smallest `--plan` file (a timeline).
- `reference.plan.cjs` documents every supported key.
- `recipes.plan.cjs` has the patterns worth copying.

Recordings default to `output/`, which is git-ignored the same way.
