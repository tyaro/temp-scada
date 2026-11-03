<script lang="ts">
  import type { DesiredRecordingPlan } from "../recording-plan";
  let { plan }: { plan: DesiredRecordingPlan } = $props();
</script>

<dl>
  <dt>計画ID / 希望設定版</dt>
  <dd>{plan.planId} / {plan.revision}</dd>
  <dt>記録設定</dt>
  <dd>{plan.enabled ? "有効" : "無効"}</dd>
  <dt>グループ / Hub参照</dt>
  <dd>{plan.group.groupId} / {plan.group.hubRef}</dd>
  <dt>周期</dt>
  <dd>{plan.group.periodMs} ms</dd>
</dl>
<ul>
  {#each plan.group.members as member (member.memberId)}<li>
      <span>{member.externalName}</span> · {member.memberId} · {member.valueType ===
      "number"
        ? "数値"
        : "真偽値"}
    </li>{/each}
</ul>

<style>
  dl {
    display: grid;
    grid-template-columns: minmax(9rem, auto) 1fr;
    gap: 0.3rem 1rem;
    margin: 0.5rem 0;
  }
  dd {
    margin: 0;
    overflow-wrap: anywhere;
    white-space: pre-wrap;
  }
  ul {
    margin: 0.5rem 0;
    padding-left: 1.4rem;
    overflow-wrap: anywhere;
  }
  li span {
    white-space: pre-wrap;
  }
</style>
