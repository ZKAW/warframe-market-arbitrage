module.exports = {
  apps: [
    {
      name: "warframe-market-terminal",
      script: "bun",
      args: "run start",
      env: {
        NODE_ENV: "production",
      }
    }
  ]
};
