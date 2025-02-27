// Require modules.
import * as core from '@actions/core';
import {readFileSync} from 'fs';
import * as yaml from 'js-yaml';

const
    secretType      = core.getInput('secretType'),
    repo            = core.getInput('repo'),
    teamsConfigPath = core.getInput('teamsConfigPath') ||
        `${ process.env.GITHUB_WORKSPACE }/defs/teams-config.yml`;


/**
 * Return the requested secret key given the repository and the secret type.
 *
 * @returns {string} The secret key.
 */
const getRepoSecretKey = () => {

    const
        teamsConfig = yaml.load(
            readFileSync(
                teamsConfigPath,
                'utf8'
            )
        );

    for ( const team in teamsConfig ) {
        const teamConfig = teamsConfig[team];
        if (teamConfig.repos.includes(repo)) {
            return _parseRepoSecrets(teamConfig.secrets, teamConfig, repo)[secretType];
        }
    }

    throw new Error(`Repository "${repo}" not found in any team.`);
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
 * Main.
 */
const main = async () => {
    core.setOutput('secretKey', getRepoSecretKey());
};

main().catch( err => core.setFailed( err.message ) );
