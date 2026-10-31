import type { Store } from "./db.ts";

export function initStewardAccounting(store: Store) {
  store.db.exec(`create table if not exists discovery_stewards(discovery text primary key, steward text not null);
    create table if not exists order_stewards(goal text primary key, steward text not null);
    create table if not exists steward_legacy_balances(domain text primary key, steward text not null, credit real not null, capital real not null, strategy text not null);
    create trigger if not exists steward_balance_sync after update of credit, capital, strategy on memory_stewards
    when new.active = 1 begin
      update memory_stewards set credit = new.credit, capital = new.capital, strategy = new.strategy
      where active = 1 and domain != new.domain and domain in
        (select id from domains where status = 'active' and steward = (select steward from domains where id = new.domain));
    end;`);
  if (store.meta("steward_accounting") !== "1") {
    store.tx(() => {
      store.run("insert or ignore into discovery_stewards(discovery, steward) select p.id, d.steward from discoveries p join domains d on d.id = p.domain");
      store.run("insert or ignore into steward_legacy_balances(domain, steward, credit, capital, strategy) select d.id, d.steward, s.credit, s.capital, s.strategy from domains d join memory_stewards s on s.domain = d.id where d.status = 'active'");
      const owners = store.all<{ steward: string }>("select distinct steward from domains where status = 'active'");
      for (const owner of owners) {
        const state = store.get<{ credit: number; capital: number; strategy: string }>(`select s.credit, s.capital, s.strategy from memory_stewards s join domains d on d.id = s.domain
          where d.steward = ? and d.status = 'active'
          order by exists(select 1 from log l where l.event = 'domain_transferred' and json_extract(l.detail, '$.domain') = d.id and json_extract(l.detail, '$.to') = d.steward), d.id limit 1`, owner.steward);
        if (state) store.run("update memory_stewards set credit = ?, capital = ?, strategy = ? where domain in (select id from domains where steward = ? and status = 'active')", state.credit, state.capital, state.strategy, owner.steward);
      }
      store.setMeta("steward_accounting", "1");
    });
  }
}

export function transferSteward(store: Store, domain: string, source: string) {
  const from = store.get<{ steward: string }>("select steward from domains where id = ? and status = 'active'", domain);
  const to = store.get<{ steward: string; credit: number; capital: number; strategy: string }>("select d.steward, s.credit, s.capital, s.strategy from domains d join memory_stewards s on s.domain = d.id where d.id = ? and d.status = 'active'", source);
  if (!from || !to) throw new Error("Transfer requires active domains");
  if (from.steward === to.steward) return to.steward;
  const other = store.get("select 1 from domains where steward = ? and status = 'active' and id != ?", from.steward, domain);
  if (!other) {
    const retired = store.id("D");
    store.run("insert into domains(id, name, description, steward, status) values(?, 'Dormant', 'Former steward', ?, 'merged')", retired, from.steward);
    store.run("insert into memory_stewards(domain, mandate, credit, capital, strategy, active) select ?, mandate, credit, capital, strategy, 0 from memory_stewards where domain = ?", retired, domain);
  }
  store.run("update domains set steward = ?, rev = rev + 1 where id = ?", to.steward, domain);
  store.run("update memory_stewards set credit = ?, capital = ?, strategy = ? where domain = ?", to.credit, to.capital, to.strategy, domain);
  return to.steward;
}

export function rewardSteward(store: Store, steward: string, value: number) {
  const state = store.get<{ domain: string }>("select s.domain from memory_stewards s join domains d on d.id = s.domain where d.steward = ? order by s.active desc, d.status = 'active' desc limit 1", steward);
  if (state) store.run("update memory_stewards set capital = max(0, capital * 0.8 + ? * 0.2), credit = max(0, credit * 0.8 + ? * 0.2) where domain = ?", value, value, state.domain);
}
