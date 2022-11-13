import {Context} from '@actions/github/lib/context'
import {GitHub} from '@actions/github/lib/utils'
import {createPullRequest} from 'octokit-plugin-create-pull-request'
import {Log} from './log'
import {Inputs, Config, Repo, File} from './types'
import {dump} from 'js-yaml'

export class FileSync {
  private readonly configFile
  private readonly repo
  private readonly dryRun
  private readonly gitSha
  private readonly htmlUrl
  private readonly octokit
  private readonly log
  private readonly runId
  private readonly repoStr

  constructor(
    inputs: Inputs,
    context: Context,
    octokit: InstanceType<typeof GitHub>,
    log: Log
  ) {
    this.log = log
    this.octokit = octokit
    this.configFile = inputs.configFile
    this.dryRun = inputs.dryRun
    this.repo = context.repo
    this.gitSha = context.sha.substring(0, 12)
    this.runId = context.runId
    this.repoStr = toRepoStr(this.repo)
    this.htmlUrl =
      context.payload.repository?.html_url ||
      `https://github.com/${this.repo.owner}/${this.repo.repo}`
  }

  /**
   * name
   */
  async loadConfigFile(): Promise<Config> {
    this.log.startGroup(
      `📝 Fetching '${this.configFile}' from ${this.repo.owner}/${this.repo.repo}`
    )
    const {config}: {config: Config} = await this.octokit.config.get({
      ...this.repo,
      path: this.configFile
    })
    this.log.info(`🛠 config:\n${dump(config)}`)
    if (!config.syncs || !config.syncs.length) {
      this.log.warning('😰 Nothing to sync')
    }
    this.log.endGroup()
    return config
  }

  toRepo(str: string): Repo {
    const input = str.split('/', 2)
    const owner = input.length === 2 ? input[0] : this.repo.owner
    const repo = input.length === 2 ? input[1] : input[0]
    return {
      owner,
      repo
    }
  }

  async run(): Promise<void> {
    this.log.info('🏃 Running GitHub File Sync')
    const config = await this.loadConfigFile()
    for (const sync of config.syncs) {
      this.log.startGroup(`📝 Fetching files from ${this.repoStr}`)
      for (const file of sync.files) {
        this.log.info(`📝 Fetching ${file.src}`)
        const {data} = await this.octokit.repos.getContent({
          ...this.repo,
          path: file.src
        })
        if ('content' in data) {
          file.content = data.content
        }
      }
      this.log.endGroup()
      for (const remoteRepoStr of sync.repos) {
        const remoteRepo = this.toRepo(remoteRepoStr)
        this.log.info(`💄 Creating pull request for ${toRepoStr(remoteRepo)}`)
        const prOptions: createPullRequest.Options = {
          ...remoteRepo,
          title: `🔃 Synced files from ${this.repoStr}`,
          body: `🔃 Synced files from [${this.repoStr}](${this.htmlUrl})\n\nThis PR was created automatically by workflow run [#${this.runId}](${this.htmlUrl}/actions/runs/${this.runId})`,
          head: `automagically-template-syncs`,
          createWhenEmpty: false,
          changes: [filesToChanges(sync.files, this.log),]
        }
        if (this.dryRun) {
          this.log.info('✔ No pull request was created due to dry run')
        } else {
          try {
            const pr = await this.octokit.createPullRequest(prOptions)
            if (pr === null) {
              this.log.info(
                '✔ No pull request was created since there were no changes'
              )
            } else {
              this.log.info(
                `✅ Pull request created: ${pr.data.number} ${pr.data.html_url}`
              )
            }
          } catch (error) {
            if (error.message === 'Reference already exists') {
              this.log.info(`⛔ Pull request already exists`)
            } else {
              throw error
            }
          }
        }
      }
    }
  }
}

function toRepoStr(repo: Repo, separator = '/'): string {
  return `${repo.owner}${separator}${repo.repo}`
}

function filesToChanges(files: File[], log: Log): createPullRequest.Changes {

  log.info('filesToChanges')

  const result = files.reduce(
    (obj: {[path: string]: createPullRequest.File}, file) => {
      const dest = file.dest ? file.dest : file.src

      log.info('Debug:  ${file.src} + ${file.content}')

      if (file.content) {

        log.info('Debug:  ${file.src}')

        if (file.src.endsWith('.sh')) {
          obj[dest] = {
            content: file.content,
            encoding: 'base64',
            mode: '100755'
          }

          log.info('🔑 Marking .sh file as executable')

        } else {
          obj[dest] = {
            content: file.content,
            encoding: 'base64',
          }

          log.info('🔑 Not touching this file')

        }

      }
      return obj
    },
    {}
  )
  return {
    emptyCommit: false,
    commit: '🔃 File Sync',
    files: result
  }
}
