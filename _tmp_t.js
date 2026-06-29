const sqlite3 = require('sqlite3');
const db = new sqlite3.Database('frag_tracker.db');
db.all('SELECT id, timestamp, length(tanks_json) len FROM lesta_tank_snapshots ORDER BY id DESC LIMIT 5', (e,r)=>{
  console.log('snapshots', r);
  db.get('SELECT lesta_account_id, lesta_reliable_since, lesta_last_tank_snapshot_at FROM app_state WHERE id=1', (e2,s)=>{
    console.log('state', s);
    db.close();
  });
});
