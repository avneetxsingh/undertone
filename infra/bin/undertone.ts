import { App } from "aws-cdk-lib";
import { UndertoneStack } from "../lib/undertone-stack";

const app = new App();
const stage = app.node.tryGetContext("stage") ?? "dev";
new UndertoneStack(app, `Undertone-${stage}`, {
  stage,
  env: { region: "us-east-1" },
});
