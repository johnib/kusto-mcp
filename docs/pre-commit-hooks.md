# Pre-commit Hooks Setup

This project uses [Husky](https://typicode.github.io/husky/) and [lint-staged](https://github.com/okonet/lint-staged) to automatically run code quality checks before commits are allowed.

## What happens on commit

When you run `git commit`, `.husky/pre-commit` runs `npx lint-staged`, which checks staged files:

### For TypeScript source files (`src/**/*.ts`)

1. **ESLint with auto-fix**: Runs `eslint --fix` to catch and automatically fix linting issues
2. **Prettier formatting**: Runs `prettier --write` to ensure consistent code formatting

This matches the scope of `npm run lint` (`eslint src`) and `npm run format` (`src/**/*.ts`).
No other files are touched. Markdown and JSON files are deliberately left out, because
running Prettier on `README.md` or `docs/*.md` reflows unrelated lines into the diff.
Files under `tests/` are not linted or formatted by the hook either.

## Installation

The hook is installed by the `prepare` script (`husky`), which `npm install` and `npm ci`
run automatically. It sets `core.hooksPath` to `.husky/_`. If you cloned before this was
added, run `npm install` once (or `npx husky`) to activate the hook.

## Behavior

- ✅ **Auto-fixable issues**: Will be automatically fixed and the commit proceeds
- ❌ **Non-fixable errors**: Will block the commit and show error details
- 🔄 **Partial fixes**: Files are updated with fixes, but you'll need to stage them again if there were non-fixable errors

## Manual commands

You can run these checks manually:

```bash
# Run lint-staged on currently staged files
npx lint-staged

# Run ESLint on all TypeScript files
npm run lint:check

# Fix ESLint issues automatically
npm run lint:fix

# Check formatting with Prettier
npm run format:check

# Fix formatting with Prettier
npm run format:fix
```

## Example workflow

```bash
# Make some changes
echo "const x = 1" >> src/example.ts

# Stage the changes
git add src/example.ts

# Attempt to commit (pre-commit hook runs automatically)
git commit -m "Add example code"

# If there are unfixable errors, fix them manually and try again
# The hook will show you exactly what needs to be fixed
```

## Configuration

The pre-commit hook configuration is in:

- **Husky**: `.husky/pre-commit` - defines which command runs on commit (`npx lint-staged`)
- **lint-staged**: `package.json` `lint-staged` section - defines which tools run on which files

## Benefits

- 🛡️ **Prevents bad code**: Blocks commits with linting errors
- 🎨 **Consistent formatting**: Automatically formats code according to project standards
- ⚡ **Fast execution**: Only runs on staged files, not the entire codebase
- 🔧 **Auto-fix**: Automatically fixes many common issues
