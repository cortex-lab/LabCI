# MATLAB-ci

A small set of modules written in Node.js for running automated tests of MATLAB code in response to GitHub events.  Also submits code coverage to the Coveralls API.

## Getting Started

Run the install script to install all dependencies, then create your .env file containing your App's tokens, secrets, etc.

### Prerequisites

Requires MATLAB 2017a or later and Node.js.  The following Node.js modules are required:

```
npm install --save express dotenv @octokit/app @octokit/request ...
github-webhook-handler smee-client xml2js
```

### Installing

Make sure runAllTests.m is on your MATLAB paths

## Running the tests

TODO

### Break down into end to end tests

Explain what these tests test and why

```
Give an example
```

### And coding style tests

Explain what these tests test and why

```
Give an example
```

## Deployment

To work properly you need to create install a Github app on your target repository and download the private key.  Update your .env file like so:

```
GITHUB_PRIVATE_KEY=path\to\private-key.pem
GITHUB_APP_IDENTIFIER=1234
GITHUB_WEBHOOK_SECRET=
WEBHOOK_PROXY_URL=https://smee.io/abcd
RIGBOX_REPO_PATH=C:\Path\To\Code\Repo
COVERALLS_TOKEN=
```

To run at startup create a batch file with the following command:

```batch
cmd /k node -r dotenv/config dotenv_config_path=/Path/To/Env/Vars ./Path/To/index.js 
```

Create a shortcut in your startup folder ([Windows-logo] + [R] in Windows-10 and enter the command `shell:startup`)

## Built With

* [Coveralls](coveralls.io) - Code coverage

## Contributing

Please read [CONTRIBUTING.md](https://gist.github.com/PurpleBooth/b24679402957c63ec426) for details on our code of conduct, and the process for submitting pull requests to us.

## Versioning

We use [SemVer](http://semver.org/) for versioning. For the versions available, see the [tags on this repository](https://github.com/your/project/tags). 

## Authors

* **Miles Wells**

## License

This project is licensed under the MIT License - see the [LICENSE.md](LICENSE.md) file for details
