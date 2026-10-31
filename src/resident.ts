import { defaultConfig, Store } from "./db.ts";
import { initMemory } from "./resident-memory.ts";

export function openResident(path: string) {
  const store = new Store(path);
  if (store.meta("resident") !== "1") {
    if (store.purpose !== undefined) throw new Error("The resident store must be separate from existing sessions");
    store.tx(() => {
      store.setMeta("resident", "1");
      store.setMeta("purpose", "");
      store.setMeta("constraints", "");
      store.setMeta("config", JSON.stringify({ ...defaultConfig, maxConcurrency: 4, maxAgents: 1000 }));
      store.setMeta("model_calls", "0");
      store.run("insert into goals(id, parent, description, status, owner, created_at) values('G0', null, '', 'review', 'host', ?)", Date.now());
      store.db.exec("create table if not exists chat(id integer primary key, role text not null, text text not null, at int not null, remembered int not null default 0)");
    });
  }
  initMemory(store);
  return store;
}

export function setOrder(store: Store, purpose: string) {
  if (store.meta("resident") !== "1") throw new Error("Not a resident store");
  if (!purpose.trim()) throw new Error("Purpose must not be empty");
  store.tx(() => {
    store.setMeta("purpose", purpose);
    store.run("update goals set description = ?, rev = rev + 1 where id = 'G0'", purpose);
    store.log("user", "order_changed", { purpose });
    for (const goal of store.all<{ id: string; owner: string }>("select id, owner from goals where id != 'G0' and status = 'open'")) {
      store.addTask({ goal: goal.id, kind: "steer", author: "user", assignee: goal.owner,
        description: `The user's top-level purpose changed to: ${purpose}\nReconsider this goal. Keep, refine, or drop it in light of the new purpose.` });
    }
  });
}
