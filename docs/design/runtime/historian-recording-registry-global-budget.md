# Historian registry resource domain model

- 設計日: 2026-11-05 JST
- 段階: H5d4c4c-prep2b5a。純粋Rust domain実装済み（2026-11-05 JST）。実接続は後続。
- 前提: [workflow renewal](historian-recording-registry-workflow-renewal.md)までの純粋Rustモデル。
- 変更しないもの: Project 0.37.0、DB7、H1、wire/schema、SDK、Banto、依存、通常App。
- 実native、host、認証、transport、実Hub/S7/本番DBは未接続。P3b保留を解除しない。

## 1. 採用範囲

複数のRegistryModelを一つの純粋Rust resource domainが所有し、登録時に各scopeの最大資源を予約する。
既存単一scopeのlease、admission、completion、read、cancel、subscription、workflow状態機械は再利用する。
別のglobal workflow状態機械やschedulerは作らない。

[wire/host設計](historian-recording-wire-host.md)の本文全owner合計16MiB、scope最大8MiB、購読全体32をモデル化する。
最小実装では**scopeのfull quotaを登録時にhard partitionとして予約**する。
read予約だけを確保してmutationを動的共有する方式は採用しない。

既定scopeは8MiBなので同domainへ最大2件登録できる。
小さいModelLimitsを明示したscopeはより多く登録できるが、scope数の独立上限も32とする。
空scopeの未使用bytesを他scopeへ貸し出さない。正常完了、detach、closeでもdomainの予約を返さない。
これにより、単一scopeが将来のcompletionを受ける時に、別scopeの活動による新しいglobal Capacityを発生させない。

この保守的な利用率を採用し、後から動的allocatorへ暗黙変更しない。
将来の共有方式は、受付時の将来証拠予約と回復read保護を含む別設計とする。

## 2. 容量の定義

| 資源                     | domain上限                | scope上限と予約                                          |
| ------------------------ | ------------------------- | -------------------------------------------------------- |
| 保持本文・既存model会計  | 16MiB                     | ModelLimits.total_bytesを登録時全量予約。最大8MiB        |
| 回復read                 | 各scope予約内             | ModelLimits.read_bytesを専用区画としmutationから借用不可 |
| mutation                 | 各scope予約内             | total_bytes − read_bytes。既定6MiB                       |
| live subscription        | 32                        | ModelLimits.live_subscriptionsを全量予約。最大4          |
| 登録scope                | 32                        | close後も登録数を維持                                    |
| ID、workflow、revision等 | 既存scope制限の総和で有限 | 各ModelLimitsの4096等を維持。domain登録で増やさない      |

既定scopeはread2MiBを含む。縮小試験用scopeでは既存ModelLimitsのread縮小を許し、予約したread上限の独立性を保つ。
「全scopeに常に2MiBを提供する」とは称さない。read自身の上限到達は従来どおり有限停止。
domainの16MiBには全scopeのread予約も含める。mutationだけ16MiBを別に確保しない。

`reserved_total = Σ limits.total_bytes`、`reserved_read = Σ limits.read_bytes`、
`reserved_mutation = Σ (limits.total_bytes − limits.read_bytes)`、
`reserved_subscriptions = Σ limits.live_subscriptions`をchecked算術で管理する。
登録時にtotalとsubscriptionの上限を両方検査する。各scope内の既存can_charge/予約検査も省略しない。

16MiBは既存modelが定義する保持本文・保守会計の上限であり、Rust allocatorの厳密なheap上限ではない。
resource ID、token、台帳index等の管理情報はscope32件・ID最大64byteで有限化する。
各ModelSessionに含むscope/contextと既存台帳管理情報は各既存入力制限を維持する。
新domainのために過去JSONを複製せず、統計だけを保持する。

## 3. owner/resourceの束縛

新しい`SimulatedResourceId`は既存ID文字集合・1..64 ASCIIで検証する。
これは同じ物理ownerを重複登録しないためのsimulation宣言であり、DB identity、認証principal、実native handleではない。
callerが異なるresource IDとownerRefを偽って同じ実ownerを表した場合、本modelはそれを検出できない。
将来hostは信頼された管理経路から一意のresource identityを割り当てる必要がある。

domain寿命中、次の関係を不変にする。

- 一つのresource IDに一つのModelSession、mode、ModelLimitsを束縛する。
- ownerRefもdomain全体で一意。epoch/context/principalが違っても別scopeとして同ownerRefを登録しない。
- 同resource IDを別ownerRefに変更しない。別principalによるquotaの増設も許さない。
- 登録済みと完全一致する要求は同じDomainScopeTicketを返すだけで追加予約しない。
- principal不一致はForbidden、同principalで既存resource/ownerの別本文・epoch・mode・limitsはProtocolViolation。

epoch更新、同physical ownerを別contextで再登録、scope退役後の再利用は本段階では提供しない。
closed/recoveryを新epochで忘れる機能にしない。
異なるownerRef/resource IDを使う独立scopeでは、同じadmissionIdやoperationId文字列を使える。
実際のticketは既存model instanceに束縛され、JSON文字列だけで別scopeへ流用できない。

## 4. 公開API案

moduleは既存`scada_runtime::recording_registry_model`配下とし、次を追加公開する。

```rust
pub struct RegistryDomain;
pub struct DomainScopeTicket { /* private Arc domain identity + slot sequence */ }
pub struct DomainScope<'a> { /* private &mut RegistryModel */ }
pub struct SimulatedResourceId(String);

pub struct DomainLimits {
    pub total_bytes: usize,       // default 16MiB、縮小のみ
    pub live_subscriptions: usize,// default 32、縮小のみ
    pub scopes: usize,            // default 32、縮小のみ
}
pub enum DomainMode {
    Standalone,
    Workflow { qualification: SimulatedRunQualification },
}
pub struct DomainRegistration {
    pub resource: SimulatedResourceId,
    pub session: ModelSession,
    pub limits: ModelLimits,
    pub mode: DomainMode,
}
impl RegistryDomain {
    pub fn new(limits: DomainLimits) -> Result<Self, ModelError>;
    pub fn register(&mut self, input: DomainRegistration)
        -> Result<DomainScopeTicket, ModelError>;
    pub fn scope<'a>(&'a mut self, ticket: &DomainScopeTicket,
        session: &ModelSession) -> Result<DomainScope<'a>, ModelError>;
    pub fn advance_to(&mut self, now: ModelInstant) -> Result<(), ModelError>;
    pub fn seal(&mut self);
    pub fn stats(&self) -> DomainStats;
}
```

DomainLimitsは全fieldで0を縮小境界として許し、既定上限超過はInvalidInputとする。0上限のdomain作成自体は成功できるが、その上限を超える予約要求はCapacityとなる。例えば購読上限0でも、scope側のlive_subscriptionsも0なら他条件を満たす登録を許す。ModelLimitsも既存validateをcache照合前に実行し、不正limitsはInvalidInput、合法limitsに変更した既登録要求はProtocolViolationとする。

DomainScopeTicketはClone可能だがprivate instance identity付き、Deserialize不可。
登録の完全一致はlimitsの全field（projection_limit/revision ceilingも含む）、modeと初回qualification、resource/sessionの全本文を含む。modelが後にclose/fault/renewalしても登録時の束縛を変えず、元完全一致のregister再送を先に処理する。
同じslot番号を持つ別domainのticketはForbidden。改変された不存在slotはInvalidInput。
scope取得時にもsession/principalの完全照合を行い、ticketの所持だけで別principalへ移管しない。

DomainScopeは既存RegistryModelの公開操作をtypedな転送methodとして提供する。
lease、admission、proof、completion、観測、cancel、inspection、購読、workflow、renewal、close、statsを転送対象とする。clockのadvanceはdomain専用とし、facadeはnowの読取だけを許す。
戻り値は既存DTO/ticketを利用し、転送層で独自のphaseやerrorを生成しない。取得時にsessionを照合した後も、既存session引数を持つtyped methodは同じsession引数を公開し、child側の既存qualificationを省略しない。ticketだけを受けるproof/completion等は、取得したchildへそのまま転送し、childのinstance帰属検査を保持する。別childをticketから自動選択しない。
`DerefMut<Target=RegistryModel>`、`&mut RegistryModel`取得、take/replace/export、任意callbackは公開しない。
`mem::replace`等で新modelへ交換して履歴を失わせる入口を作らない。

既存の単独RegistryModel公開APIは低レベルsimulation用として維持する。
単独で作ったmodelはdomain保証の対象外であり、domainへ後付けimportするAPIは設けない。
「同プロセス内の全RegistryModelを強制管理する」仕組みではない。
管理rootが一つのdomainを使うことが本モデルの保証範囲である。

## 5. 登録の原子性

登録は次の順に計画する。

1. resource ID、ModelSession、ModelLimits、DomainModeを検証する。
2. 同resource/ownerの既存記録を調べ、principalと完全一致条件を確認する。exact再送を返す。
3. 新規登録ではsealされていないこと、domain ClockFaultがないこと、scope数、total bytes、subscription全予約を検査する。sealはClosed、faultはClockFaultを返す。
4. 内部の未公開RegistryModelを従来constructorで作る。初期descriptor1024bytes等の既存検証も実行し、domainの現在仮想時刻を継承させる。
5. ticket sequenceをchecked更新可能か確認し、domain recordと全予約を一度だけcommitする。

失敗したconstructor/上限/sequence/照合は、domain counters、旧scope、owner binding、seal状態を変更しない。
未公開modelの破棄には実native/外部効果がない。
最大bytesの予約はscopeの現在statsから計算しない。空scopeでも登録時に全quotaを使う。

scope操作ではglobal quotaを追加取得しない。内部の同じModelLimitsで既存原子検査を行う。
このため各操作後にglobal超過を発見してrollbackする実装や、巨大modelのclone/stagingは不要。
将来ModelLimitsを増やすresize APIは提供しない。

## 6. 所有・close・Drop

RegistryDomainが全modelを所有する。DomainScopeは短いexclusive borrowであり、同domainに同時に二つのmutable scope操作を開始できない。
これはRustの逐次simulation上の全caller gateであり、async workerの実行排他ではない。
借用を返す/落とすことはscopeのclose、reservation解放、operation取消を意味しない。
DomainScopeTicketのDropや全client ticketの消失でも登録台帳を消さない。

`scope.close()`は従来どおりそのmodelを閉じ、既存close publication creditを使う。
close成功後も同scopeのexact再送・既登録証拠回収・観測の既存許可を維持し、domain quotaを返さない。
もう一つのscopeのclosed/recoveryやclockを変更しない。

`domain.seal()`は新規scope登録だけを永久停止する。既存scope操作を止めたり全scopeをcloseしたりしない。
seal後のexact register再送は可能。sealを解除するAPIはない。
全scopeを一括closeするtransactionは設けず、必要ならcallerが既存scopeごとに明示closeする。

domain Dropは純粋simulationの全保持物を破棄するだけで、実workerを静止させた証拠ではない。
新domain作成で実ownerのrecovery/IDをresetできるとは称さない。
実host shutdown/handoff/persistenceの安全性は別契約であり、このmodelで実装済みにしない。

## 7. 時刻と状態の独立

domainは一つのModelInstant（初期0）とsticky clock_faultを所有する。`RegistryDomain::advance_to`だけが全childの時刻を進める。facadeにadvance/reset時計APIを公開しない。
同値/前進は全childへ同じ時刻を設定する。新scopeも登録時に現在時刻を継承し、0へ戻ってlease期限を延長する抜け道を作らない。
逆行要求はnowを変更せずdomainと全childのclock_faultを立て、ClockFaultを返す。これは既存単一scope同様、意図的にsticky faultを残すエラーであり、一般の受付失敗不変条件の例外として試験する。
逆行処理は既存advanceのfault設定を再利用し、subscription publication/revisionやcloseを発生させない。全childへの設定にfallibleな途中処理を入れない。
fault後の前進でもfaultは解除しない。新scope登録は拒否するが、完全一致registration再送は先に返す。

各facade呼出へdomain fault/closedの一律gateを追加しない。既存childの入口順序を維持し、proof/completion、元call回収、既知exact再送、許可されたreadを利用できるようにする。
特に現行attachはclosedでは拒否するがClockFaultでは拒否しない。control/inspection等も既存の終了後規則に従う。
sealは既存childをfault/closedにせず、新規登録だけを止める。

renewal、ever_clean_joined、全ID/native pool、readUncertain/recovery、snapshot highwaterはscope内で従来どおり保持する。
異なるscopeのproof/receiptを混ぜない。閉じたscopeの本文を再予約可能な空きに数えない。
共通仮想時刻は実Instant/UTC較正やschedulerを実装した意味ではない。

## 8. dispatcher・native上限との区別

単一scopeは既存の未終端admission dispatcher1、pending観測2/role、pending cancel1、live購読4の制限を維持する。
domainでは登録scope数による有限総和となる。最大32scopeならdispatcher最多32、観測最多64/role、cancel最多32である。
これは最大可能なsimulation状態の数であり、実native task数/reader lease数を増設するものではない。

live購読は各scopeの最大枠をdomainが予約するため、実active数は常に全体32以内。
未使用subscription枠を他scopeへ貸さない。detachでscope内live枠が空いてもdomainの予約は不変。

実HistoryReaderの2lease、native ownerの4096ID、SQLite writer所有、同physical ownerの全caller排他を本modelのdomain countersで代替しない。
real registry/native adapter着手時には実resource identityと実worker admissionの別設計が必要。
本段階では新しいfake global native capを発明しない。

## 9. 統計と保持の説明

DomainStatsはreserved_total/read/mutation/subscriptions、registered_scopes、sealed、clock_fault、nowを有限な値として返す。
actual使用量の合計fieldは本段階では追加しない。現在のmutation_bytes/read_bytes/live_subscriptions等は、各ticketで既存per-scope statsから取得する。
reservedと現在使用量を同じfieldにしない。現在使用量の減少を再登録余力として扱わない。
未接続のnative task数、OS heap、物理DB容量を示すfieldは作らない。

全scope一覧を返すAPIは初回に不要。callerは保存したticketでscope statsを取得する。
ID紛失から新登録で履歴を回避できないよう、同registrationのexact再送を復旧入口にする。
認証資格の再発行や別principalへticketを譲渡するAPIではない。

## 10. 実装PRと受入

prep2b5aとして、domainのhard partition登録、opaque ticket、typed borrow facade、統計、純粋Rust試験を一PRにまとめる。
動的allocator、scope GC/retire/epoch交換、process永続化は後続へ残す。
新wire/schemaやTS権威モデルは追加しない。必要なbrowser試験は既存wire DTO transcriptの受理確認に限定する。

| 受入      | 内容                                                                                       |
| --------- | ------------------------------------------------------------------------------------------ |
| 既定容量  | default8MiB scope2件成功、3件目Capacity、全旧scope不変                                     |
| partition | mutation満杯でも同scopeの予約readを利用可能、他scopeのread/証拠保存も維持                  |
| 縮小      | 明示小quotaの複数scope、scope数exact/1超過、bytes exact/1不足                              |
| 購読      | 合計予約32 exact、33拒否。detach/close後もdomain予約は戻らない                             |
| identity  | 同registration exact再送無課金、別principal Forbidden、同owner別epoch/context/resource拒否 |
| ticket    | 別domain/別scopeのinstance ticketを拒否、元simulation ticketのcross-scope使用拒否          |
| history   | workflow renewalでscope内履歴維持、旧ID/結果/close/recoveryを登録し直して消せない          |
| 原子性    | constructor失敗、global容量不足、sequence限界で登録/予約/既存snapshot不変                  |
| 時計      | 全childと後発登録の同時刻、逆行で全child sticky fault、fault後exact登録/read/proofを維持   |
| lifetime  | facade/ticket Dropは無効果、scope.closeは他scopeへ無効果、sealは既存操作を妨げない         |
| 未接続    | native/clock/network callback無し、既存Standalone/Workflow全scenario回帰                   |

型テストでは公開mutable model参照/持ち出しがないことを確認する。
共有scenarioを追加する場合もRustだけがdomain遷移を実行する。
既存単一scopeの正常・障害・再送受入をdomain facade経由でも代表例で確認し、転送時に独自gateを混入しない。

## 11. 実装と検証の区切り

`recording_registry_model/domain/mod.rs`へ全量予約・双方向identity照合・opaque scope ticket・共通仮想時計・sealと統計を実装した。`domain/facade.rs`は25の既存typed APIだけを転送し、独立advanceや可変modelの持ち出しを提供しない。全体の予約は登録後に返却せず、scope内の未使用workflow枠やdetachの局所返却から他scopeへの余力を作らない。

`domain/tests.rs`の14件は全体bytes・購読・scope数の境界、全ModelLimitsの再送照合、constructor／sequence失敗の原子性、交差するowner／principal、回復readと予約済completion、共通時計・seal・Dropを検証する。compile-fail2件はmodel交換とscopeの独立advanceを拒否する。既存六つの共有fixtureの289シナリオは単独／domain両経路で実行し、各domainシナリオの終了後に登録再送が初期資格と元ticket・現在状態を維持することも確認する。JSONの試験命令やwire/schemaは追加しない。

Astraの最終read-onlyレビューに残る必須所見はない。TS／browserは既存の共有期待DTOを既存validatorで検証し、第二のdomain実行機構は作らない。受信frameの順序・矛盾検出、実adapter／host・P3bは後続である。
