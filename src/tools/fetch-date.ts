(async () => {
  const config = {
    "type": "function",
    "name": "fetch_date",
    "description": "Fetches current date.",
    "parameters": {
      "type": "object",
      "properties": {},
      "required": []
    },
    "strict": false
  }

  async function fetch_date() {
    return new Date().toLocaleDateString('bg-BG', { year: 'numeric', month: 'long', day: 'numeric' });
  }

  exports.fetch_date_config = config;
  exports.fetch_date = fetch_date;
})();
