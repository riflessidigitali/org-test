Find Repository Secret
===================

GitHub workflow action to find a repository secret key as defined in [../../../defs/teams-config.yml](./defs/teams-config.yml) given a repository name and a secret type.

---

## Install and Build

Run `npm install` to install the required deps.

To build the action, run `npm run build`. 
The build process will generate two files:
- the action build file located at [./dist/index.js](./dist/index.js) 
- a license file located at [./dist/licenses.text](./dist/licenses.txt) listing the licenses for every dependency used by this action, and this action's license itself.

## Coding Standards

Run `npm run cs-check` to run eslint, and `npm run cs-fix` to automatically fix fixable coding standard issues.
