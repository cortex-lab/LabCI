# MATLAB-ci

A small set of modules written in Node.js for running automated tests of MATLAB code in response to GitHub events.  Also submits code coverage to the Coveralls API.

Currently unsupported:
* Running tests on forked repositories
* 

## Getting Started

Run the install script to install all dependencies, then create your .env file containing your App's tokens, secrets, etc.

### Prerequisites

Requires MATLAB 2017a or later, Node.js and Git Bash.  The following Node.js modules are required:

```
npm install --save express dotenv @octokit/app @octokit/request ...
github-webhook-handler xml2js localtunnel
```

### Installing

Make sure runAllTests.m is on your MATLAB paths

## Running the tests

```
mocha ./test
```

## Deployment

To work properly you need to create install a 
[Github app](https://docs.github.com/en/free-pro-team@latest/developers/apps/creating-a-github-app)
on your target repository and download the private key.  Update your .env file like so:

```
GITHUB_PRIVATE_KEY=path\to\private-key.pem
GITHUB_APP_IDENTIFIER=1234
GITHUB_WEBHOOK_SECRET=
WEBHOOK_PROXY_URL=
REPO_PATH=C:\Path\To\Code\Repo
REPO_NAME=
REPO_OWNER=
TUNNEL_HOST=
TUNNEL_SUBDOMAIN=
```

To run at startup create a batch file with the following command:

```batch
cmd /k node -r dotenv/config dotenv_config_path=/Path/To/Env/Vars ./Path/To/main.js 
```

Create a shortcut in your startup folder ([Windows-logo] + [R] in Windows-10 and enter the command `shell:startup`)

## Test script
Your test script must do the following:
1. Accept a commit ID as an input arg
2. Save the results into the JSON cache file without duplication
3. For code coverage the script must either save the coverage directly, or export a Cobertura formatted XML file.

## Built With

* [LocalTunnel](https://localtunnel.me) - A secure tunneling service
* [Shields.io](shields.io) - Display shields

## Contributing

Please read [CONTRIBUTING.md](https://gist.github.com/PurpleBooth/b24679402957c63ec426) for details on our code of conduct, and the process for submitting pull requests to us.

## Versioning

We use [SemVer](http://semver.org/) for versioning. For the versions available, see the [tags on this repository](https://github.com/your/project/tags). 

## Authors

* **Miles Wells**

## License

This project is licensed under the MIT License - see the [LICENSE.md](LICENSE.md) file for details
