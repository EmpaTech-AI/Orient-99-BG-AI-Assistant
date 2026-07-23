(async () => {
  const config = {
    "type": "function",
    "name": "fetch_time",
    "description": "Fetches current time.",
    "parameters": {
      "type": "object",
      "properties": {},
      "required": []
    },
    "strict": false
  }

  async function fetch_time() {
    return new Date().toLocaleTimeString('bg-BG', { hour: '2-digit', minute: '2-digit' });
  }

  exports.fetch_time_config = config;
  exports.fetch_time = fetch_time;
})();
