// Require modules.
import * as core from '@actions/core';
import * as github from '@actions/github';
import {readFileSync} from 'fs';
import * as yaml from 'js-yaml';
import {Octokit} from '@octokit/core';
import {createOrUpdateTextFile} from '@octokit/plugin-create-or-update-text-file';

// Setup global vars.
let
    reposConfig       = {},
    _octokitInstances = {};

const
    secrets        = JSON.parse(core.getInput('secrets')),
    org            = core.getInput('org'),
    what           = core.getInput('what'),
    syncSourceDirPath = `${ process.env.GITHUB_WORKSPACE }/.github/templates`;

let processDeletion = core.getInput('process_deletion');

/**
 * Create an array of {repo : { project, owner, secrets }...} and save it globally.
 */
const buildreposConfig = async () => {
    const
        teamsConfig = yaml.load(
            readFileSync(
                `${ process.env.GITHUB_WORKSPACE }/defs/teams-config.yml`,
                'utf8'
            )
        ),
        octokit     = _getOctokitInstance(secrets.CSPF_REPO_READ_PAT);

    let repos = await octokit.paginate(
        'GET /orgs/{org}/repos',
        {
            org,
        }
    );
    repos = repos
        .filter(({archived, disabled}) => false === archived && false === disabled);

    repos.forEach((repo) => {
        reposConfig[repo.name] = reposConfig[repo.name] || [];
        for ( const team in teamsConfig ) {
            const teamConfig = teamsConfig[team];
            if (teamConfig.repos?.includes(repo.name)) {
                reposConfig[repo.name] = {
                    project: teamConfig.project,
                    owner: teamConfig.owner,
                    secrets: _parseRepoSecrets(teamConfig.secrets, teamConfig, repo.name),
                    syncedFiles: _parseRepoSyncedFiles(teamConfig, repo.name),
                };
            }
        }
    });
};

/**
 * Create, update or delete the project automation workflow on each repository.
 */
const updateProjectAutomationRepos = async () => {
    // Read the template.
    const workflow = readFileSync(
        `${syncSourceDirPath}/workflow/project-automation.yml`,
        'utf8'
    );

    // For each company's repository create, update or delete the project automation workflow.
    for ( const repo in reposConfig ) {
        const
            project        = reposConfig[repo].project ?? '',
            owner          = reposConfig[repo].owner ?? '',
            issueManagePat = reposConfig[repo].secrets?.['issue-manage'] ?? '';

        let repoWorkflow = null;

        if (project) {
            repoWorkflow = workflow.replace(/{{{PROJECT_ORG}}}/g, org);
            repoWorkflow = repoWorkflow.replace(/{{{PROJECT_ID}}}/g, project);
            repoWorkflow = repoWorkflow.replace(/{{{PRIMARY_CODEOWNER}}}/g, `"@${owner}"`);
            repoWorkflow = repoWorkflow.replace(/{{{ISSUE_MANAGE_PAT}}}/g, issueManagePat);
        }

        await _createOrUpdateFileContent(
            getSyncedFileSecretKeyFromType('workflow'),
            repo,
            getSyncedFileDestinationBasePathFromType('workflow') + '/project-automation.yml',
            repoWorkflow
        );

    }
};

/**
 * Create, update or delete the PHPUnit automation workflow on each repository.
 */
const updatePHPUnitAutomationRepos= async () => {
    const
        skipVar = 'ORG_PHPUNIT_SKIP',
        filesToCheck = [ // To check files existence.
            'phpunit.xml',
            '.phpunit.xml.dist',
            'phpunit.xml.dist',
            'phpunit.ruleset.xml',
        ];

    await _createOrUpdateFile(
        `${syncSourceDirPath}/workflow/phpunit.yml`,
        getSyncedFileDestinationBasePathFromType('workflow') + '/phpunit.yml',
        getSyncedFileSecretKeyFromType('workflow'),
        skipVar,
        filesToCheck
    );
};

/**
 * Create, update or delete the PHPCS automation workflow on each repository.
 */
const updatePHPCSAutomationRepos = async () => {

    const
        skipVar = 'ORG_PHPCS_SKIP',
        filesToCheck = [ // To check files existence.
            '.phpcs.xml.dist',
            'phpcs.xml',
            'phpcs.xml.dist',
            'phpcs.ruleset.xml',
        ];

    await _createOrUpdateFile(
        `${syncSourceDirPath}/workflow/phpcs.yml`,
        getSyncedFileDestinationBasePathFromType('workflow') + '/phpcs.yml',
        getSyncedFileSecretKeyFromType('workflow'),
        skipVar,
        filesToCheck
    );
};

/**
 * Update the issue template on each repository.
 *
 * @param {string} issueTemplate The issue template to update.
 */
const updateIssueTemplateRepos = async (issueTemplate) => {
    const
        name                = issueTemplate.split('/')[1],
        type                = getSyncedFileTypeFromPath(issueTemplate),
        skipVar             = 'ORG_ISSUE_TEMPLATES_SKIP.' + name.replace(/\.(md|yml)$/, '');

    await _createOrUpdateFile(
        `${syncSourceDirPath}/${issueTemplate}`,
        getSyncedFileDestinationBasePathFromType(type) + '/' + name,
        getSyncedFileSecretKeyFromType(type),
        skipVar,
        null
    );
};

/**
 * Update the configured synced files on each repository.
 *
 * @param {string} template The template to update.
 */
const updateConfiguredSyncedFileRepos = async (template) => {
    const
        name                = template.split('/')[1],
        type                = getSyncedFileTypeFromPath(template),
        fileContent         = readFileSync(
            `${syncSourceDirPath}/${template}`,
            'utf8'
        );

    for ( const repo in reposConfig ){
        let repoSyncedFile = null;
        if (reposConfig[repo]['syncedFiles']?.includes(template)) {
            repoSyncedFile = fileContent.replace(
                /{{{REPO_WRITE_PAT}}}/g,
                reposConfig[repo].secrets?.['repo-write'] ?? ''
            );
        }

        await _createOrUpdateFileContent(
            getSyncedFileSecretKeyFromType(type),
            repo,
            getSyncedFileDestinationBasePathFromType(type) + '/' + name,
            repoSyncedFile,
            `The repository ${repo} does not have the ${template} associated, and deletion is disabled: see process_deletion action's parameter.`
        );
    }
}

/**
 * Returns the secret key for the specified template type.
 *
 * @param {string} type The type of template.
 * @returns {string} The secret key for the specified template type.
 */
const getSyncedFileSecretKeyFromType = (type) => {
    switch (type) {
        case 'issue':
        case 'workflow':
            return 'workflow-manage';
        default:
            return 'repo-write';
    }
}

/**
 * Returns the type of synced file from the path.
 *
 * @param {string} path The path to the synced file.
 * @returns {string} The type of synced file.
 */
const getSyncedFileTypeFromPath = (path) => {
    return path.split('/')[0];
}

/**
 * Returns the destination path for the specified template type.
 *
 * @param {string} type The type of template.
 * @returns {string} The destination path for the specified template type.
 */
const getSyncedFileDestinationBasePathFromType = (type) => {
    switch (type) {
        case 'workflow':
            return '.github/workflows';
        case 'issue':
            return '.github/ISSUE_TEMPLATE';
        default:
            return '.';
    }
}

/**
 * Returns an array of synced files that include the specified repository.
 *
 * @param {object} teamConfig The team configuration object.
 * @param {string} repo       The name of the repository to filter synced files by.
 * @returns {Array<string>} An array of synced files names that include the specified repository.
 */
const _parseRepoSyncedFiles = (teamConfig, repo) => {

    let repoSyncedFiles = [];

    if (teamConfig['synced-files']) {        
        for ( const syncedFile in teamConfig['synced-files'] ) {
            if (teamConfig['synced-files'][syncedFile].includes(repo)) {
                repoSyncedFiles.push(syncedFile);
            }
        }
    }

    return repoSyncedFiles;
};

/**
 * Parse repository secrets based on team configuration and repository.
 *
 * @param {object} secrets    The list of secrets to be parsed.
 * @param {object} teamConfig The team configuration object.
 * @param {string} repo       The repository name.
 * @returns {object} The parsed list of secrets
 */
const _parseRepoSecrets = (secrets, teamConfig, repo) => {
    /**
     * PATs have a limit of 50 repo.
     * So we add an _N suffix to each secret when the repository
     * index in the team is greater than 49 (array index start at 0).
     * Where N values 1 from 50 to 99, 2 from 100 to 149 and so on...
     */
    const repoIndex = teamConfig.repos.indexOf(repo);
    if (repoIndex < 50){
        return secrets;
    }
    let newSecrets = {};
    for ( const secret in secrets ) {
        newSecrets[secret] = secrets[secret] + '_' + (Math.floor(repoIndex/50));
    }
    return newSecrets;
};

/**
 * Check if certain conditions are met to skip a repository.
 *
 * A repo is skipped if any of the following conditions are met:
 * - the repository is not owned and we don't allow the file deletion;
 * - we require to check a skipVar and the repo var is set to require the skip;
 * - we require the existence of some files and they are not present.
 *
 * @param {string}   repo         The name of the repository.
 * @param {string}   skipVar      A repo variable name to check against to determine if the repo should be skipped.
 * @param {string[]} filesToCheck List of files to check for existence to determine if the repo should be skipped.
 * @returns {boolean} Whether to skip the repository or not.
 */
const _skipRepo = async (repo, skipVar, filesToCheck) => {
    return (
        // If the repository is not owned and we don't allow the file deletion.
        ( ! reposConfig[repo].owner && !processDeletion ) ||
        // If we require to check a skipVar and the repo var is set to require the skip.
        ( skipVar && await _repoVarRequiresSkip(repo, skipVar) ) ||
        // If we require the existence of some files and they are not present.
        ( filesToCheck && ! await _checkRepoFilesExist(filesToCheck, repo) )
    );
};

/**
 * Check if a repository requires to be skipped based on a action variable.
 *
 * @param {string} repo    The name of the repository.
 * @param {string} skipVar A repo variable name to check against to determine if the repo should be skipped.
 * @returns {boolean} Returns true if the repo needs to be skipped, false otherwise.
 */
const _repoVarRequiresSkip = async (repo, skipVar) => {
    const octokitVarRead = _getOctokitInstance(secrets.CSPF_REPO_VARS_READ_PAT);
    try {
        const
            theVar       = skipVar.split('.')[0],
            theValue     = skipVar.split('.')[1];

        skipVar = theVar;
        const 
            {data} = await octokitVarRead.request(
                'GET /repos/{org}/{repo}/actions/variables/{skipVar}',
                {
                    org,
                    repo,
                    skipVar
                }
            ),
            repoVarValue = data.value ?? false;
        console.log(repoVarValue);
        return repoVarValue && theValue ?
            repoVarValue.filter((str) => str.toLowerCase().includes(theValue.toLowerCase())) :
            'true' === repoVarValue;

    } catch (error) {
        // If the variable is not found, we assume the automation is allowed (return false).
        if (error.status === 404) {
            return false;
        }
        if (error.status === 403) {
            // Authentication issue.
            console.log(error);
            core.setFailed(error.messages) ;
            throw error;
        }
        console.log(error);
        return true; // Skip.
    }
};

/**
 * Checks if the specified files exist in the given repository.
 *
 * @param {string[]} filesToCheck An object containing the files to check.
 * @param {string}   repo         The name of the repository to check.
 * @returns Returns true if at least one file is found, false after checking all files.
 */
const _checkRepoFilesExist = async (filesToCheck, repo) => {
    const octokitRead = _getOctokitInstance(secrets.CSPF_REPO_READ_PAT);
    for ( const path of filesToCheck ) {
        try {
            await octokitRead.request(
                'GET /repos/{org}/{repo}/contents/{path}',
                {
                    org,
                    repo,
                    path
                }
            );
            return true;
        } catch (error) {
            // Nothing to do.
        }
    }

    return false;
};

/**
 * Update a generic file based on the source file, destination file, secret key, skip variable, and files to check.
 *
 * @param {string}   sourceFile   The path to the source file.
 * @param {string}   destFile     The path to the destination file.
 * @param {string}   secretKey    The secret key, in the repo secrets array, to use to manage the file.
 * @param {string}   skipVar      A repo variable name to check against to determine if the repo should be skipped.
 * @param {string[]} filesToCheck List of files to check for existence to determine if the repo should be skipped.
 */
const _createOrUpdateFile = async (sourceFile, destFile, secretKey, skipVar, filesToCheck) => {
    // Read the template.
    const content = readFileSync(
        sourceFile, 'utf8'
    );

    if (!content) {
        return;
    }
    // For each company's repository create, update or delete file.
    for ( const repo in reposConfig ) {
        try {
            if ( ! (await _skipRepo(repo, skipVar, filesToCheck)) ) {
                await _createOrUpdateFileContent(
                    secretKey,
                    repo,
                    destFile,
                    content
                );
            } else {
                console.log(
                    'Skipping %s: The repository is not owned by any team, or misses the required files, or opted out via the %s variable',
                    repo,
                    skipVar
                );
            }
        } catch(error) {
            // Error already handled down the line.
        }
    }
};

/**
 * Create or update a file on a repository.
 *
 * @param {string} secretKey  The team's secrets array key to retrieve the secret to use to create the file.
 * @param {string} repo       The repo name.
 * @param {string} file       The file path to create or update (or delete).
 * @param {string} content    The content of the file.
 * @param {string} skipReason The reason to show when skipping a repository.
 */
const _createOrUpdateFileContent = async (secretKey, repo, file, content, skipReason) => {
    if (!content && !processDeletion) {
        console.log(
            'Skipping %s: %s',
            repo,
            skipReason ?? 'The repository is not associated to any teams, and workflow deletion is disabled: see process_deletion action\'s parameter.',
        );
        return;
    }

    // Missing secrets for the repository.
    if (! (reposConfig[repo].secrets ?? '')) {
        core.setFailed(`Cannot find the secrets for the "${repo}" repository in teams config file.`);
        return;
    }

    // Missing secret key for the repository.
    if (! (reposConfig[repo].secrets[secretKey] ?? '')) {
        core.setFailed(`Cannot find the secret key "${secretKey}" for the "${repo}" repository in the teams config file.`);
        return;
    }

    // Missing required organization secret.
    if (! (secrets[reposConfig[repo].secrets[secretKey]] ?? '')) {
        core.setFailed(`Cannot find the organization secret "${reposConfig[repo].secrets[secretKey]}" for the "${repo}" repository among the organization action secrets.`);
        return;
    }

    const
        octokitCreate = _getOctokitInstance(
            secrets[reposConfig[repo].secrets[secretKey]],
            'textCRUD'
        ),
        _action = content ? 'Creating/Updating' : 'Deleting';

    console.log(
        '%s the "%s" workflow file on %s',
        _action,
        file.split(/[\\/]/).pop(),
        repo
    );

    try {
        await octokitCreate.createOrUpdateTextFile({
            owner: org,
            repo: repo,
            path: file,
            content: content, // When equals to null the workflow file will be deleted.
            message: `${_action} ${file} [skip ci]`
        });
    } catch (error) {
        console.log(
            'An error occurred while %s the "%s" workflow file on "%s" with the secret "%s"',
            _action.toLowerCase(),
            file.split(/[\\/]/).pop(),
            repo,
            reposConfig[repo].secrets[secretKey]
        );
        console.log(error);
        core.setFailed(error.messages) ;
    }
};

/**
 * Retrieves Octokit instance: if not already cached, creates and caches it.
 *
 * @param {string} key  Octokit instance key in the cache, usually a token.
 * @param {string} type Can be 'global' or 'textCRUD'. Default is 'global'.
 * @returns {object} Octokit instance or Octokit instance with the plugin `createOrUpdateTextFile`, associated with the given key.
 */
const _getOctokitInstance = (key, type) => {
    type = type || 'global';
    if (
        Object.hasOwn(_octokitInstances,key) &&
        Object.hasOwn(_octokitInstances[key],type)
    ) {
        return _octokitInstances[key][type];
    }

    let octokitInstance = null;
    if ('global' === type) {
        octokitInstance = github.getOctokit(key);
    } else {
        const _Octokit = Octokit.plugin(createOrUpdateTextFile);
        octokitInstance = new _Octokit({auth:key});
    }
    if (!Object.hasOwn(_octokitInstances,key)) {
        _octokitInstances[key]={};
    }
    _octokitInstances[key][type] = octokitInstance;
    return  _octokitInstances[key][type];
};

/**
 * Main.
 */
const main = async () => {
    switch (processDeletion){
        case 'true':
        case true:
        case 1:
        case '1':
            processDeletion = true;
            break;
        default:
            processDeletion = false;
    }

    await buildreposConfig();

    switch (what) {
        case 'workflow/project-automation.yml':
            await updateProjectAutomationRepos();
            break;
        case 'workflow/phpcs.yml':
            await updatePHPCSAutomationRepos();
            break;
        case 'workflow/phpunit.yml':
            await updatePHPUnitAutomationRepos();
            break;
        case (/^issue\/.+\.(md|yml)$/.test(what) ? what : null):
            await updateIssueTemplateRepos(what);
            break;
        case (/^workflow\/.+\.yml$/.test(what) ? what : null):
            await updateConfiguredSyncedFileRepos(what);
            break;
    }
};

main().catch( err => core.setFailed( err.message ) );
