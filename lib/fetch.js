const { Agent } = require("node:undici");

const ipv4Agent = new Agent({
  connect: {
    family: 4
  }
});

function fetchWithAgent(url, options = {}) {
  return fetch(url, { ...options, dispatcher: ipv4Agent });
}

module.exports = { fetchWithAgent, ipv4Agent };
