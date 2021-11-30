#!/usr/bin/env node
/* eslint-disable import/no-extraneous-dependencies */
import chalk from "chalk";
import Commander from "commander";
import path from "path";
import prompts from "prompts";
import { createApp } from "./create-app";
import { validateNpmName } from "./helpers/validate-pkg";
import packageJson from "./package.json";

let projectPath: string = "";

const program = new Commander.Command(packageJson.name)
  .version(packageJson.version)
  .arguments("<project-directory>")
  .usage(`${chalk.green("<project-directory>")} [options]`)
  .action((name) => {
    projectPath = name;
    console.log(`projectPath: ${projectPath}`);
  })
  .option(
    "--ts, --typescript",
    `
  Initialize as a TypeScript project.
`
  )
  .option(
    "--use-npm",
    `
  Explicitly tell the CLI to bootstrap the app using npm
`
  )
  .allowUnknownOption()
  .parse(process.argv);

async function run(): Promise<void> {
  if (typeof projectPath === "string") {
    projectPath = projectPath.trim();
  }
  if (!projectPath) {
    const res = await prompts({
      type: "text",
      name: "path",
      message: "What is your project named?",
      initial: "my-app",
      validate: (name) => {
        const validation = validateNpmName(path.basename(path.resolve(name)));
        if (validation.valid) {
          return true;
        }
        return "Invalid project name: " + validation.problems![0];
      },
    });

    if (typeof res.path === "string") {
      projectPath = res.path.trim();
    }
  }

  const resolvedProjectPath = path.resolve(projectPath);
  const projectName = path.basename(resolvedProjectPath);

  const { valid, problems } = validateNpmName(projectName);
  if (!valid) {
    console.error(
      `Could not create a project called ${chalk.red(
        `"${projectName}"`
      )} because of npm naming restrictions:`
    );

    problems!.forEach((p) => console.error(`    ${chalk.red.bold("*")} ${p}`));
    process.exit(1);
  }

  try {
    await createApp({
      appPath: resolvedProjectPath,
      useNpm: !!program.useNpm,
      typescript: program.typescript,
    });
  } catch (error) {
    console.log(error);
  }
}

run()
  .then()
  .catch(async (reason) => {
    console.log();
    console.log("Aborting installation.");
    if (reason.command) {
      console.log(`  ${chalk.cyan(reason.command)} has failed.`);
    } else {
      console.log(chalk.red("Unexpected error. Please report it as a bug:"));
      console.log(reason);
    }
    console.log();

    process.exit(1);
  });
