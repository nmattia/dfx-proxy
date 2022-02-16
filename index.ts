#!/usr/bin/env ts-node

import express from "express";
import morgan from "morgan";
import { createProxyMiddleware } from "http-proxy-middleware";
import { readFileSync } from "fs";

type CanisterId = string;
type CanisterName = string;

type Port = number;

interface Config {
  replicaHost?: string;
  canisterIdToPort: Record<CanisterId, Port>;
  canisterNameToPort: Record<CanisterName, Port>;
  canisterNameToId: Record<CanisterName, CanisterId>;
  canisterIdsFile?: string;
}

// Parse all the arguments, returning an error string if parsing failed.
const getConfig = (origArgs: string[]): Config | string => {
  let args = origArgs;
  return parseArgs(args);
};

const parseArgs = (origArgs: string[]): Config | string => {
  let args = origArgs;
  let replicaHost;
  let canisterIdsFile;

  // Read CLI value for replica host
  const replicaArgIndex = args.indexOf("--replica-host");
  if (replicaArgIndex !== -1) {
    // Remove the '--replica-host http://...' from the args and store the value
    const replicaArgs = args.splice(replicaArgIndex, 2);
    if (replicaArgs.length != 2) {
      return "No value for --replica-host";
    }
    replicaHost = replicaArgs[1];
  }

  // Read CLI value for canister_ids.json
  const canisterIdsFileIndex = args.indexOf("--canister-ids-file");
  if (canisterIdsFileIndex !== -1) {
    // Remove the '--canister-ids-file canister_ids.json' from the args and store the value
    const canisterIdsArgs = args.splice(canisterIdsFileIndex, 2);
    if (canisterIdsArgs.length != 2) {
      return "No value for --canister-ids-file";
    }
    canisterIdsFile = canisterIdsArgs[1];
  }

  // Parse the rest of the args as canister/port mappings
  //
  const result = parseCanisterIdToPort(args);
  if (typeof result === "string") {
    return result;
  }
  let canisterIdToPort = result[0];
  args = result[1];

  const result_ = parseCanisterNameToPort(args);
  if (typeof result_ === "string") {
    return result_;
  }
  let canisterNameToPort = result_[0];
  args = result_[1];

  if (args.length != 0) {
    return `Error: Don't know what to do with ${args.length} argument(s): ${args}`;
  }

  return {
    replicaHost,
    canisterIdsFile,
    canisterIdToPort,
    canisterNameToPort,
    canisterNameToId: {},
  };
};

// Parse the canister ID to port mappings (rwajt-...:8086 rdm6x-...:443 ...)
const parseCanisterIdToPort = (
  args: string[]
): [Record<CanisterName, Port>, string[]] | string =>
  parseCanisterToPort("--by-id", args);

// Parse the canister name to port mappings (my-canister:8086 assets:443 ...)
const parseCanisterNameToPort = (
  args: string[]
): [Record<CanisterName, Port>, string[]] | string =>
  parseCanisterToPort("--by-name", args);

// Parse the canister name to port mappings (my-canister:8086 assets:443 ...)
const parseCanisterToPort = (
  param: string,
  args: string[]
): [Record<string, Port>, string[]] | string => {
  const canisterToPort: Record<string, Port> = {};

  for (
    let canisterToPortArgIndex;
    (canisterToPortArgIndex = args.indexOf(param)) != -1;

  ) {
    const canisterToPortArgs = args.splice(canisterToPortArgIndex, 2);
    if (canisterToPortArgs.length != 2) {
      return `No value for ${param}`;
    }

    const [_, arg] = canisterToPortArgs;

    const tokens = arg.split(":");

    if (tokens.length != 2) {
      return `Could not parse '${arg}'`;
    }

    const [canister, portStr] = tokens;

    const port = parseInt(portStr);

    if (Number.isNaN(port)) {
      return `Could not parse port '${portStr}' as number`;
    }

    canisterToPort[canister] = port;
  }

  return [canisterToPort, args];
};

// An app that:
// * logs the requests (green for 2XX, blue for 3XX, yellow for 4XX and red for
//      5XX)
// * listens on the specified port and proxies to
//      '<replicaHost>/?canisterId=<canisterId>'
const mkApp = ({
  replicaHost,
  port,
  canisterId,
}: {
  replicaHost: string;
  port: number;
  canisterId: string;
}) => {
  const app = express();

  // could use morgan's .token() thingy but really not worth it here
  app.use(
    morgan((_, req, res) => {
      const color = (rc: number) => {
        if (rc >= 200 && rc < 300) {
          return 32; // GREEN
        } else if (rc >= 300 && rc < 400) {
          return 34; // BLUE
        } else if (rc >= 400 && rc < 500) {
          return 33; // YELLOW
        } else {
          return 35; // RED
        }
      };

      return `${canisterId} (${port}) \x1b[${color(res.statusCode)}m${
        res.statusCode
      }\x1b[0m ${req.method} ${req.originalUrl} -> ${req.url} `;
    })
  );

  app.all(
    "*",
    createProxyMiddleware({
      target: replicaHost,
      pathRewrite: (pathAndParams, req) => {
        let queryParamsString = `?`;

        const [path, params] = pathAndParams.split("?");

        if (params) {
          queryParamsString += `${params}&`;
        }

        queryParamsString += `canisterId=${canisterId}`;

        return path + queryParamsString;
      },
    })
  );

  app.listen(port, "localhost", () => {
    console.log(
      `Canister ${canisterId} is listening on http://localhost:${port}`
    );
  });
};

const usage = "USAGE: proxy --replica-host http://... [<canister-id>:<port>]";

const main = () => {
  const args = process.argv.slice(2);

  if (args.indexOf("--help") != -1) {
    console.log(usage);
    process.exit(0);
  }

  const parsed = getConfig(args);

  if (typeof parsed === "string") {
    console.log(parsed);
    console.log(usage);
    process.exit(1);
  }

  let {
    replicaHost,
    canisterIdsFile,
    canisterNameToPort,
    canisterNameToId,
    canisterIdToPort,
  } = parsed;

  if (Object.keys(canisterIdToPort).length == 0) {
    console.log("No canisters to proxy");
    console.log(usage);
    process.exit(1);
  }

  if (!replicaHost) {
    console.log("No replica to proxy to"); // TODO: explain how
    console.log(usage);
    process.exit(1);
  }

  if (canisterIdsFile) {
    console.log("Canister ids file");

    try {
      const content = readFileSync(canisterIdsFile, "utf8");
      const values = JSON.parse(content);
      for (const canisterName in values) {
        const localCanisterId = values[canisterName].local;
        if (localCanisterId) {
          canisterNameToId[canisterName] = localCanisterId;
        }
      }
    } catch (e) {
      console.log(`Could not read canister IDs from file ${canisterIdsFile}`);
      console.log(e);
      console.log(usage);
      process.exit(1);
    }
  }

  for (let canisterName in canisterNameToPort) {
    let canisterPort = canisterNameToPort[canisterName];
    let canisterId = canisterNameToId[canisterName];

    if (!canisterId) {
      console.log(
        `No canister ID for canister name '${canisterName}' when trying to proxy '${canisterName}' to port ${canisterPort}`
      );
      console.log(usage);
      process.exit(1);
    }

    if (canisterIdToPort[canisterId]) {
      console.log(
        `Asking to forward canister '${canisterName}' (name) to port ${canisterPort} but '${canisterName}' is '${canisterId}' (ID) and is already forwarded to port ${canisterIdToPort[canisterId]}`
      );
      console.log(usage);
      process.exit(1);
    }

    canisterIdToPort[canisterId] = canisterPort;
  }

  console.log("Using the following mappings:");

  console.log(canisterIdToPort);

  for (const canisterId in canisterIdToPort) {
    const port = canisterIdToPort[canisterId];
    console.log(
      `Forwarding ${port} to ${replicaHost}/?canisterId=${canisterId}`
    );
    mkApp({ replicaHost, port, canisterId });
  }
};

main();
