Stand-in Lambda asset for API stacks synthesized without `API_BUILD_DIR`
(e.g. `cdk ls`, or synthesizing the deploy-role stack). `src/api.ts` attaches
an error annotation whenever this is used, so `cdk deploy` refuses to ship it.
