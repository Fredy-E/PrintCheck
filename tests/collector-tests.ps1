# PrintCheck collector tests -- synthetic providers only.
#
# SAFETY CONTRACT:
#   * This suite NEVER runs the production collector against this host.
#   * It dot-sources the collector with -LibraryOnly and injects fake providers.
#   * The one dot-source-without-LibraryOnly case runs in a CHILD PowerShell
#     process where Get-Printer / Get-PrinterDriver / Get-PrinterPort /
#     Get-CimInstance are shadowed by recording fakes, so even a broken guard
#     cannot touch a real print system.
#   * The -Sample CLI cases collect only clearly fictional built-in data.
#   * The atomic-create race case runs two CHILD processes whose Test-Path is
#     shadowed (inside the child only, for the generated target path) so the
#     old check-then-write window is exercised deterministically; the race
#     children only ever write into this suite's temp directory.
#
# The file is intentionally pure ASCII (Windows PowerShell 5.1 reads BOM-less
# files as ANSI); non-ASCII test data is built with [char] codes.

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$LASTEXITCODE = 0

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$collectorPath = (Resolve-Path (Join-Path $scriptDir '..\collector\Collect-PrintCheck.ps1')).Path
$script:Pass = 0
$script:Fail = 0
$script:Failures = New-Object System.Collections.ArrayList

# ---------------------------------------------------------------------------
# tiny assertion helpers (no Pester dependency)
# ---------------------------------------------------------------------------

function Assert-True {
  param([bool]$Condition, [string]$Name)
  if ($Condition) {
    $script:Pass++
    Write-Host ('PASS  ' + $Name)
  } else {
    $script:Fail++
    [void]$script:Failures.Add($Name)
    Write-Host ('FAIL  ' + $Name)
  }
}

function Assert-Equal {
  param($Expected, $Actual, [string]$Name)
  $same = $false
  if ($null -eq $Expected -and $null -eq $Actual) { $same = $true }
  elseif ($null -ne $Expected -and $null -ne $Actual) {
    if ($Expected -is [array] -or $Actual -is [array]) {
      $same = ((@($Expected) -join '|') -eq (@($Actual) -join '|'))
    } else {
      $same = ($Expected -eq $Actual)
    }
  }
  Assert-True -Condition $same -Name $Name
  if (-not $same) {
    Write-Host ('      expected: [' + [string]$Expected + '] actual: [' + [string]$Actual + ']')
  }
}

function Assert-Match {
  param([string]$Pattern, $Actual, [string]$Name)
  $ok = ($null -ne $Actual) -and ([string]$Actual -match $Pattern)
  Assert-True -Condition $ok -Name $Name
  if (-not $ok) { Write-Host ('      value: [' + [string]$Actual + ']') }
}

function Assert-LessOrEqual {
  param([double]$Actual, [double]$Limit, [string]$Name)
  Assert-True -Condition ($Actual -le $Limit) -Name $Name
  if ($Actual -gt $Limit) { Write-Host ('      actual: ' + $Actual + ' limit: ' + $Limit) }
}

# Strict-mode-safe property access for objects that may lack the property.
function Get-Prop {
  param($Object, [string]$Name)
  if ($null -eq $Object) { return $null }
  if ($Object -is [System.Collections.IDictionary]) {
    if ($Object.Contains($Name)) { return $Object[$Name] } else { return $null }
  }
  $property = $Object.PSObject.Properties[$Name]
  if ($null -eq $property) { return $null }
  return $property.Value
}

# Run a child PowerShell with the SAME host executable as this suite, without
# letting native stderr interact with the strict error preference.
function Invoke-ChildPwsh {
  param([string[]]$Arguments)
  $exe = (Get-Process -Id $PID).Path
  $previousEap = $ErrorActionPreference
  $nativeVar = Get-Variable -Name PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue
  $nativePrevious = $null
  if ($null -ne $nativeVar) {
    $nativePrevious = $nativeVar.Value
    Set-Variable -Name PSNativeCommandUseErrorActionPreference -Value $false
  }
  $ErrorActionPreference = 'Continue'
  $output = $null
  $code = -1
  try {
    $output = & $exe -NoProfile -NonInteractive @Arguments 2>&1
    $code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousEap
    if ($null -ne $nativeVar) {
      Set-Variable -Name PSNativeCommandUseErrorActionPreference -Value $nativePrevious
    }
  }
  return [pscustomobject]@{ Output = ($output | Out-String); ExitCode = $code }
}

# ---------------------------------------------------------------------------
# fake data (clearly fictional; canaries prove field allowlisting)
# ---------------------------------------------------------------------------

function New-FakeQueue {
  param(
    [string]$Name = 'FICTION-Queue-Alpha',
    [string]$DriverName = 'Fictional Print Driver',
    [string]$PortName = 'FICTION-Port-01',
    $Shared = $false,
    [string]$Status = 'Idle'
  )
  [pscustomobject]@{
    Name = $Name
    DriverName = $DriverName
    PortName = $PortName
    Shared = $Shared
    PrinterStatus = $Status
    JobName = 'FICTION-JOB-CANARY'
    DocumentName = 'FICTION-DOC-CANARY'
  }
}

function New-FakeDriver {
  param([string]$Name = 'Fictional Print Driver')
  [pscustomobject]@{
    Name = $Name
    PrinterEnvironment = 'Windows ARM64'
    MajorVersion = 4
    Manufacturer = 'Fiction Works'
    DriverVersion = '1.2.3'
    SomeSecret = 'FICTION-SECRET-CANARY'
  }
}

function New-FakePort {
  param([string]$Name = 'FICTION-Port-01')
  [pscustomobject]@{
    Name = $Name
    Description = 'Fictional TCP/IP port'
    PrinterHostAddress = '192.0.2.10'
    PortNumber = 9100
    SNMPCommunity = 'FICTION-SECRET-CANARY'
  }
}

function New-FakeOs {
  [pscustomobject]@{
    Caption = 'Fictional Test OS'
    Version = '10.0.99999'
    BuildNumber = '99999'
    OSArchitecture = 'FIC-ARM64'
  }
}

function New-FakeProviders {
  param(
    [scriptblock]$Queues,
    [scriptblock]$Drivers,
    [scriptblock]$Ports,
    [scriptblock]$HostProvider
  )
  $map = @{}
  if ($null -ne $Queues) { $map['queues'] = $Queues }
  else { $map['queues'] = { @( (New-FakeQueue), (New-FakeQueue -Name 'FICTION-Queue-Beta' -Shared $true) ) } }
  if ($null -ne $Drivers) { $map['drivers'] = $Drivers }
  else { $map['drivers'] = { @( New-FakeDriver ) } }
  if ($null -ne $Ports) { $map['ports'] = $Ports }
  else { $map['ports'] = { @( New-FakePort ) } }
  if ($null -ne $HostProvider) { $map['host'] = $HostProvider }
  else { $map['host'] = { New-FakeOs } }
  return $map
}

function New-TestDoc {
  param([hashtable]$ProviderMap, [string]$Mode = 'test')
  if ($null -eq $ProviderMap) { $ProviderMap = New-FakeProviders }
  return New-PrintCheckDoc -ProviderMap $ProviderMap -Mode $Mode `
    -MachineName 'FICTION-TEST-HOST' -PowerShellVersion '9.9.9-test' -ProcessorArchitecture 'FIC-ARM64'
}

# ---------------------------------------------------------------------------
# temp workspace
# ---------------------------------------------------------------------------

$tempRoot = Join-Path $env:TEMP ('PrintCheckTests-' + $PID)
New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null

# ---------------------------------------------------------------------------
# 1. library load and guard behavior
# ---------------------------------------------------------------------------

. $collectorPath -LibraryOnly

Assert-True -Condition ($null -ne (Get-Command New-PrintCheckDoc -ErrorAction SilentlyContinue)) 'library: New-PrintCheckDoc is defined after -LibraryOnly dot-source'
Assert-True -Condition ($null -ne (Get-Command New-PrintCheckSampleDoc -ErrorAction SilentlyContinue)) 'library: New-PrintCheckSampleDoc is defined'
Assert-True -Condition ($null -ne (Get-Command Write-PrintCheckDoc -ErrorAction SilentlyContinue)) 'library: Write-PrintCheckDoc is defined'
Assert-True -Condition ($null -ne (Get-Command Invoke-PrintCheckMain -ErrorAction SilentlyContinue)) 'library: Invoke-PrintCheckMain is defined'
Assert-True -Condition ($null -ne (Get-Command Get-PrintCheckDefaultProviders -ErrorAction SilentlyContinue)) 'library: Get-PrintCheckDefaultProviders is defined'
Assert-True -Condition ($null -eq (Get-Variable -Name PrintCheckMainRan -ErrorAction SilentlyContinue)) 'library: -LibraryOnly dot-source did not run main'

# Production providers are only described here (scriptblocks are inspected,
# never invoked), so this suite still never touches the host.
$prodProviders = Get-PrintCheckDefaultProviders
Assert-Equal @('drivers', 'host', 'ports', 'queues') (@($prodProviders.Keys) | Sort-Object) 'providers: map exposes exactly queues/drivers/ports/host'
Assert-Match 'Get-Printer\b' ([string]$prodProviders['queues']) 'providers: queues uses the documented Get-Printer cmdlet'
Assert-Match 'Get-PrinterDriver' ([string]$prodProviders['drivers']) 'providers: drivers uses the documented Get-PrinterDriver cmdlet'
Assert-Match 'Get-PrinterPort' ([string]$prodProviders['ports']) 'providers: ports uses the documented Get-PrinterPort cmdlet'
Assert-Match 'Win32_OperatingSystem' ([string]$prodProviders['host']) 'providers: host uses the documented Win32_OperatingSystem class'
Assert-True -Condition (-not ([string]$prodProviders['ports']).Contains('SNMPCommunity')) 'providers: ports never requests SNMP community strings'

# Guard: dot-sourcing WITHOUT -LibraryOnly must not execute anything.
$guardDir = Join-Path $tempRoot 'guard'
$guardWork = Join-Path $guardDir 'work'
New-Item -ItemType Directory -Path $guardWork -Force | Out-Null
$guardMarker = Join-Path $guardDir 'RAN.marker'
$guardScriptPath = Join-Path $guardDir 'guard-child.ps1'
$guardContent = @'
param([string]$CollectorPath, [string]$WorkDir, [string]$MarkerPath)
Set-Location -LiteralPath $WorkDir
function Get-Printer { Set-Content -LiteralPath $MarkerPath -Value 'ran' -Encoding Ascii; @() }
function Get-PrinterDriver { Set-Content -LiteralPath $MarkerPath -Value 'ran' -Encoding Ascii; @() }
function Get-PrinterPort { Set-Content -LiteralPath $MarkerPath -Value 'ran' -Encoding Ascii; @() }
function Get-CimInstance { Set-Content -LiteralPath $MarkerPath -Value 'ran' -Encoding Ascii; $null }
. $CollectorPath
exit 0
'@
[System.IO.File]::WriteAllText($guardScriptPath, $guardContent, (New-Object System.Text.UTF8Encoding($false)))
$guard = Invoke-ChildPwsh -Arguments @('-File', $guardScriptPath, $collectorPath, $guardWork, $guardMarker)
Assert-True -Condition (-not (Test-Path -LiteralPath $guardMarker)) 'guard: plain dot-source never executed a query provider (even when shadowed by fakes)'
Assert-Equal 0 (@(Get-ChildItem -LiteralPath $guardWork -Filter '*.json' -ErrorAction SilentlyContinue)).Count 'guard: plain dot-source wrote no output file'

# ---------------------------------------------------------------------------
# 2. New-PrintCheckDoc with fake providers
# ---------------------------------------------------------------------------

$doc = New-TestDoc -ProviderMap (New-FakeProviders)

Assert-Equal 'printcheck.collector' (Get-Prop $doc 'schema') 'doc: schema name'
Assert-Equal 1 (Get-Prop $doc 'schemaVersion') 'doc: schemaVersion is 1'
Assert-Equal 'PrintCheck Collector' (Get-Prop (Get-Prop $doc 'tool') 'name') 'doc: tool name'
Assert-Match '^\d+\.\d+\.\d+$' (Get-Prop (Get-Prop $doc 'tool') 'version') 'doc: tool version is semver-shaped'
Assert-Equal 'test' (Get-Prop (Get-Prop $doc 'tool') 'mode') 'doc: tool mode is passed through'
Assert-True -Condition ($null -ne ([datetime]::Parse([string](Get-Prop $doc 'generatedAt')))) 'doc: generatedAt parses as a timestamp'

$hostBlock = Get-Prop $doc 'host'
Assert-Equal 'ok' (Get-Prop $hostBlock 'status') 'host: status ok'
Assert-Equal 'FICTION-TEST-HOST' (Get-Prop $hostBlock 'hostName') 'host: machine name override used'
Assert-Equal '9.9.9-test' (Get-Prop $hostBlock 'powershellVersion') 'host: PowerShell version recorded'
Assert-Equal 'FIC-ARM64' (Get-Prop $hostBlock 'processorArchitecture') 'host: processor architecture recorded'
Assert-Equal 'Fictional Test OS' (Get-Prop (Get-Prop $hostBlock 'os') 'caption') 'host: OS caption from provider'
Assert-Equal '99999' (Get-Prop (Get-Prop $hostBlock 'os') 'build') 'host: OS build from provider'

$sources = Get-Prop $doc 'sources'
Assert-Equal @('drivers', 'ports', 'queues') (@($sources.PSObject.Properties.Name) | Sort-Object) 'sources: exactly queues/drivers/ports'
Assert-Equal 'ok' (Get-Prop (Get-Prop $sources 'queues') 'status') 'queues: status ok'
Assert-Equal 2 (Get-Prop (Get-Prop $sources 'queues') 'count') 'queues: raw count recorded'
Assert-Equal 2 (@(Get-Prop (Get-Prop $sources 'queues') 'items')).Count 'queues: two items kept'
Assert-Equal $false (Get-Prop (Get-Prop $sources 'queues') 'truncated') 'queues: not truncated'
Assert-Equal 0 (Get-Prop (Get-Prop $sources 'queues') 'droppedItemCount') 'queues: no dropped items'

$queueItem = @(Get-Prop (Get-Prop $sources 'queues') 'items')[0]
Assert-Equal @('driverName', 'name', 'portName', 'shared', 'status') (@($queueItem.PSObject.Properties.Name) | Sort-Object) 'queue item: exact allowlisted field set'
Assert-Equal 'FICTION-Queue-Alpha' (Get-Prop $queueItem 'name') 'queue item: name'
Assert-Equal $false (Get-Prop $queueItem 'shared') 'queue item: shared is a boolean'
Assert-Equal 'Idle' (Get-Prop $queueItem 'status') 'queue item: status mapped from PrinterStatus'

$driverItem = @(Get-Prop (Get-Prop $sources 'drivers') 'items')[0]
Assert-Equal @('driverVersion', 'environment', 'majorVersion', 'manufacturer', 'name') (@($driverItem.PSObject.Properties.Name) | Sort-Object) 'driver item: exact allowlisted field set'
Assert-Equal 'Windows ARM64' (Get-Prop $driverItem 'environment') 'driver item: environment'

$portItem = @(Get-Prop (Get-Prop $sources 'ports') 'items')[0]
Assert-Equal @('description', 'hostAddress', 'name', 'portNumber') (@($portItem.PSObject.Properties.Name) | Sort-Object) 'port item: exact allowlisted field set'
Assert-Equal '192.0.2.10' (Get-Prop $portItem 'hostAddress') 'port item: host address recorded'

$json = $doc | ConvertTo-Json -Depth 12
Assert-True -Condition (-not $json.Contains('CANARY')) 'doc JSON: no secret/job canaries anywhere'
Assert-True -Condition (-not $json.Contains('JobName')) 'doc JSON: no JobName key'
Assert-True -Condition (-not $json.Contains('DocumentName')) 'doc JSON: no DocumentName key'
Assert-True -Condition (-not $json.Contains('SNMPCommunity')) 'doc JSON: no SNMPCommunity key'
Assert-True -Condition (-not $json.Contains('SomeSecret')) 'doc JSON: no unknown provider fields'

$provenance = Get-Prop $doc 'provenance'
Assert-Equal 'collector/Collect-PrintCheck.ps1' (Get-Prop $provenance 'script') 'provenance: script path'
Assert-Equal 'test' (Get-Prop $provenance 'mode') 'provenance: mode'
Assert-Equal 0 (@(Get-Prop $provenance 'queriesExecuted')).Count 'provenance: test mode executed no queries'

$unknowns = @(Get-Prop $doc 'unknowns')
Assert-True -Condition ($unknowns.Count -ge 6) 'unknowns: at least six documented unknowns'
$topics = @($unknowns | ForEach-Object { Get-Prop $_ 'topic' })
foreach ($topic in @('mopria-certification', 'ipp-escl-capability', 'windows-protected-print-mode', 'print-success', 'scan-success', 'readiness')) {
  Assert-True -Condition ($topics -contains $topic) ('unknowns: topic ' + $topic + ' present')
}
$states = @($unknowns | ForEach-Object { Get-Prop $_ 'state' })
Assert-True -Condition (@($states | Where-Object { $_ -notin @('unknown', 'not-tested') }).Count -eq 0) 'unknowns: only unknown/not-tested states'

$limits = Get-Prop $doc 'limits'
Assert-Equal 500 (Get-Prop $limits 'maxItemsPerSource') 'limits: maxItemsPerSource 500'
Assert-Equal 300 (Get-Prop $limits 'maxStringLength') 'limits: maxStringLength 300'

# ---------------------------------------------------------------------------
# 3. bounded failures and edge cases
# ---------------------------------------------------------------------------

$failingDoc = New-TestDoc -ProviderMap (New-FakeProviders -Drivers { throw 'FICTION-THROW-CANARY-X9 exploded here' })
Assert-Equal 'failed' (Get-Prop (Get-Prop (Get-Prop $failingDoc 'sources') 'drivers') 'status') 'failure: failing provider marks the source failed'
Assert-Equal 'provider-error' (Get-Prop (Get-Prop (Get-Prop (Get-Prop $failingDoc 'sources') 'drivers') 'error') 'kind') 'failure: canonical provider-error code'
Assert-Match 'omitted' (Get-Prop (Get-Prop (Get-Prop (Get-Prop $failingDoc 'sources') 'drivers') 'error') 'message') 'failure: fixed generic message'
Assert-True -Condition (-not ([string](Get-Prop (Get-Prop (Get-Prop (Get-Prop $failingDoc 'sources') 'drivers') 'error') 'message')).Contains('exploded')) 'failure: raw provider exception text is not carried'
$failingJson = $failingDoc | ConvertTo-Json -Depth 12
Assert-True -Condition (-not $failingJson.Contains('FICTION-THROW-CANARY-X9')) 'failure: provider exception canary absent from document JSON'
Assert-True -Condition (-not $failingJson.Contains('exploded')) 'failure: provider exception text absent from document JSON'
Assert-LessOrEqual ([string](Get-Prop (Get-Prop (Get-Prop (Get-Prop $failingDoc 'sources') 'drivers') 'error') 'message')).Length 400 'failure: error message bounded to 400 chars'
Assert-Equal 'ok' (Get-Prop (Get-Prop (Get-Prop $failingDoc 'sources') 'queues') 'status') 'failure: other sources stay ok'

$longErrorDoc = New-TestDoc -ProviderMap (New-FakeProviders -Queues { throw ('x' * 1000) })
Assert-LessOrEqual ([string](Get-Prop (Get-Prop (Get-Prop (Get-Prop $longErrorDoc 'sources') 'queues') 'error') 'message')).Length 400 'failure: long exception text never reaches the message (bounded)'
Assert-True -Condition (-not (($longErrorDoc | ConvertTo-Json -Depth 12).Contains('xxxx'))) 'failure: long exception payload absent from document JSON'

$hostFailDoc = New-TestDoc -ProviderMap (New-FakeProviders -HostProvider { throw 'FICTION-HOST-THROW-CANARY-X9' })
$failedHost = Get-Prop $hostFailDoc 'host'
Assert-Equal 'failed' (Get-Prop $failedHost 'status') 'host failure: host status failed'
Assert-Equal $null (Get-Prop $failedHost 'os') 'host failure: os block is null'
Assert-Equal 'provider-error' (Get-Prop (Get-Prop $failedHost 'error') 'kind') 'host failure: canonical provider-error code'
Assert-Match 'omitted' (Get-Prop (Get-Prop $failedHost 'error') 'message') 'host failure: fixed generic message'
Assert-True -Condition (-not (($hostFailDoc | ConvertTo-Json -Depth 12).Contains('FICTION-HOST-THROW-CANARY-X9'))) 'host failure: raw exception canary absent from document JSON'

# Canonical prose handling (fix round 1): provider text, port descriptions and
# error kinds are replaced with bounded built-in values before anything leaves
# the collector.
$portPrivacyDoc = New-TestDoc -ProviderMap (New-FakeProviders -Ports { @( [pscustomobject]@{ Name = 'FICTION-Port-Privacy'; Description = 'credential=FICTION-DESC-CANARY-X9'; PrinterHostAddress = '192.0.2.77'; PortNumber = 9100 } ) })
$privacyPortItem = @(Get-Prop (Get-Prop (Get-Prop $portPrivacyDoc 'sources') 'ports') 'items')[0]
Assert-Equal $null (Get-Prop $privacyPortItem 'description') 'privacy: port description is never carried'
Assert-Equal '192.0.2.77' (Get-Prop $privacyPortItem 'hostAddress') 'privacy: factual host address still recorded'
Assert-True -Condition (-not (($portPrivacyDoc | ConvertTo-Json -Depth 12).Contains('FICTION-DESC-CANARY-X9'))) 'privacy: description canary absent from document JSON'

$fallbackError = New-PrintCheckError -Kind 'FICTION-KIND-CANARY-X9'
Assert-Equal 'error' (Get-Prop $fallbackError 'kind') 'error helper: unrecognized kinds fall back to the canonical error code'
Assert-True -Condition (-not ([string](Get-Prop $fallbackError 'message')).Contains('FICTION-KIND-CANARY-X9')) 'error helper: message never echoes the kind'
Assert-Equal 'The provider query failed; error details are omitted.' (Get-Prop (New-PrintCheckError -Kind 'provider-error') 'message') 'error helper: canonical provider-error message'

$mopriaEntry = @(Get-Prop $doc 'unknowns' | Where-Object { (Get-Prop $_ 'topic') -eq 'mopria-certification' })[0]
Assert-Equal 'Mopria certification is a vendor program; queue metadata cannot establish it.' (Get-Prop $mopriaEntry 'reason') 'unknowns: canonical mopria explanation'

$emptyDoc = New-TestDoc -ProviderMap (New-FakeProviders -Queues { @() })
Assert-Equal 'ok' (Get-Prop (Get-Prop (Get-Prop $emptyDoc 'sources') 'queues') 'status') 'empty: empty queue list is ok'
Assert-Equal 0 (Get-Prop (Get-Prop (Get-Prop $emptyDoc 'sources') 'queues') 'count') 'empty: count 0'
Assert-Equal 0 (@(Get-Prop (Get-Prop (Get-Prop $emptyDoc 'sources') 'queues') 'items')).Count 'empty: zero items'

$nullDoc = New-TestDoc -ProviderMap (New-FakeProviders -Queues { })
Assert-Equal 0 (Get-Prop (Get-Prop (Get-Prop $nullDoc 'sources') 'queues') 'count') 'empty: a provider returning nothing is treated as zero items'

$minimalDoc = New-TestDoc -ProviderMap (New-FakeProviders -Queues { @( [pscustomobject]@{ Name = 'FICTION-Minimal-Queue' } ) })
$minimalItem = @(Get-Prop (Get-Prop (Get-Prop $minimalDoc 'sources') 'queues') 'items')[0]
Assert-Equal 'FICTION-Minimal-Queue' (Get-Prop $minimalItem 'name') 'minimal: name-only item kept'
Assert-Equal $null (Get-Prop $minimalItem 'driverName') 'minimal: missing driverName becomes null'
Assert-Equal $null (Get-Prop $minimalItem 'shared') 'minimal: missing shared becomes null'

$orphanDoc = New-TestDoc -ProviderMap (New-FakeProviders -Queues { @( [pscustomobject]@{ DriverName = 'Fictional Orphan' } ) })
Assert-Equal 0 (@(Get-Prop (Get-Prop (Get-Prop $orphanDoc 'sources') 'queues') 'items')).Count 'orphan: item without a name is dropped'
Assert-Equal 1 (Get-Prop (Get-Prop (Get-Prop $orphanDoc 'sources') 'queues') 'droppedItemCount') 'orphan: droppedItemCount 1'

$manyQueues = @(1..620 | ForEach-Object { New-FakeQueue -Name ('FICTION-Q-' + $_.ToString('0000')) })
$boundedDoc = New-TestDoc -ProviderMap (New-FakeProviders -Queues ({ $manyQueues }.GetNewClosure()))
Assert-Equal 620 (Get-Prop (Get-Prop (Get-Prop $boundedDoc 'sources') 'queues') 'count') 'bounded: raw count 620 recorded'
Assert-Equal 500 (@(Get-Prop (Get-Prop (Get-Prop $boundedDoc 'sources') 'queues') 'items')).Count 'bounded: items capped at 500'
Assert-Equal $true (Get-Prop (Get-Prop (Get-Prop $boundedDoc 'sources') 'queues') 'truncated') 'bounded: truncated flag set'

$hostileName = '<script>alert("x")</script>' + ('A' * 400) + [string][char]10 + "quote'end"
$hostileQueueObject = New-FakeQueue -Name $hostileName
$hostileDoc = New-TestDoc -ProviderMap (New-FakeProviders -Queues ({ @( $hostileQueueObject ) }.GetNewClosure()))
$hostileItem = @(Get-Prop (Get-Prop (Get-Prop $hostileDoc 'sources') 'queues') 'items')[0]
Assert-Equal 300 ([string](Get-Prop $hostileItem 'name')).Length 'hostile: overlong name truncated to 300'
Assert-Equal $hostileName.Substring(0, 300) (Get-Prop $hostileItem 'name') 'hostile: truncation keeps the leading characters'

# ---------------------------------------------------------------------------
# 4. Write-PrintCheckDoc: encoding, refusal, round-trip
# ---------------------------------------------------------------------------

$unicodeName = 'FICTION-Queue-' + [char]0x00E9 + [char]0x2192 + [char]0x2705
$unicodeQueueObject = New-FakeQueue -Name $unicodeName
$writeDoc = New-TestDoc -ProviderMap (New-FakeProviders -Queues ({ @( $unicodeQueueObject ) }.GetNewClosure()))
$nestedOut = Join-Path $tempRoot 'nested\deeper\unicode.json'
$written = Write-PrintCheckDoc -Doc $writeDoc -Path $nestedOut
Assert-True -Condition (Test-Path -LiteralPath $nestedOut) 'write: creates parent directories and writes the file'
Assert-Equal $nestedOut $written 'write: returns the resolved path'

$writtenBytes = [System.IO.File]::ReadAllBytes($nestedOut)
$hasBom = ($writtenBytes.Length -ge 3) -and ($writtenBytes[0] -eq 0xEF) -and ($writtenBytes[1] -eq 0xBB) -and ($writtenBytes[2] -eq 0xBF)
Assert-Equal $false $hasBom 'write: UTF-8 output has no BOM'
$roundTrip = ([System.Text.Encoding]::UTF8.GetString($writtenBytes) | ConvertFrom-Json)
$roundItem = @(Get-Prop (Get-Prop (Get-Prop $roundTrip 'sources') 'queues') 'items')[0]
Assert-Equal $unicodeName (Get-Prop $roundItem 'name') 'write: unicode round-trips through the UTF-8 file'

$refused = $false
$refuseMessage = ''
try { Write-PrintCheckDoc -Doc $writeDoc -Path $nestedOut | Out-Null }
catch { $refused = $true; $refuseMessage = $_.Exception.Message }
Assert-True -Condition $refused 'write: refuses to overwrite an existing file silently'
Assert-Match 'overwrite' $refuseMessage 'write: refusal message mentions overwrite'
$forced = Write-PrintCheckDoc -Doc $writeDoc -Path $nestedOut -Force
Assert-Equal $nestedOut $forced 'write: -Force overwrites explicitly'

$dirTargetThrew = $false
$dirTargetMessage = ''
try { Write-PrintCheckDoc -Doc $writeDoc -Path $tempRoot | Out-Null }
catch { $dirTargetThrew = $true; $dirTargetMessage = $_.Exception.Message }
Assert-True -Condition $dirTargetThrew 'write: an existing directory target is refused'
Assert-Match 'directory' $dirTargetMessage 'write: directory-target message is clear'

# Atomic no-Force create: two simultaneous writers on one fresh path must not
# both succeed. The generated children shadow Test-Path for the target only, so
# the old check-then-write window is held open deterministically; a correct
# CreateNew-only writer bypasses the shadow and wins at the filesystem level.
$raceDir = Join-Path $tempRoot 'race'
New-Item -ItemType Directory -Path $raceDir -Force | Out-Null
$raceTarget = Join-Path $raceDir 'race.json'
$raceChildPath = Join-Path $raceDir 'race-child.ps1'
$raceChildContent = @'
param([string]$CollectorPath, [string]$Target, [string]$ReadyPath, [string]$ReleasePath)
$ErrorActionPreference = 'Stop'
. $CollectorPath -LibraryOnly
$script:RaceTarget = [IO.Path]::GetFullPath($Target)
$script:RaceReady = $ReadyPath
$script:RaceRelease = $ReleasePath
function Test-Path {
  param([string]$LiteralPath, [string]$Path)
  $candidate = $LiteralPath
  if ([string]::IsNullOrEmpty($candidate)) { $candidate = $Path }
  if ([string]::Equals([IO.Path]::GetFullPath($candidate), $script:RaceTarget, [StringComparison]::OrdinalIgnoreCase)) {
    $staleExists = [IO.File]::Exists($script:RaceTarget)
    [IO.File]::WriteAllText($script:RaceReady, 'ready')
    $clock = [Diagnostics.Stopwatch]::StartNew()
    while (-not [IO.File]::Exists($script:RaceRelease)) {
      if ($clock.Elapsed.TotalSeconds -gt 25) { throw 'Synthetic race release timeout' }
      [Threading.Thread]::Sleep(10)
    }
    return $staleExists
  }
  return ([IO.File]::Exists($candidate) -or [IO.Directory]::Exists($candidate))
}
$code = Invoke-PrintCheckMain -Sample -OutFile $Target
exit $code
'@
[System.IO.File]::WriteAllText($raceChildPath, $raceChildContent, (New-Object System.Text.UTF8Encoding($false)))
$raceReadyA = Join-Path $raceDir 'ready-a'
$raceReadyB = Join-Path $raceDir 'ready-b'
$raceRelease = Join-Path $raceDir 'release'
$raceExe = (Get-Process -Id $PID).Path
function Start-RaceChild {
  param([string]$ReadyPath)
  $raceArgs = '-NoProfile -NonInteractive -File "' + $raceChildPath + '" "' + $collectorPath + '" "' + $raceTarget + '" "' + $ReadyPath + '" "' + $raceRelease + '"'
  return Start-Process -FilePath $raceExe -ArgumentList $raceArgs -PassThru -WindowStyle Hidden
}
$raceA = Start-RaceChild -ReadyPath $raceReadyA
$raceB = Start-RaceChild -ReadyPath $raceReadyB
$raceDeadline = (Get-Date).AddSeconds(25)
while ((Get-Date) -lt $raceDeadline -and
       -not (($raceA.HasExited -and $raceB.HasExited) -or
             ((Test-Path -LiteralPath $raceReadyA) -and (Test-Path -LiteralPath $raceReadyB)))) {
  Start-Sleep -Milliseconds 50
}
if (-not (Test-Path -LiteralPath $raceRelease)) { [System.IO.File]::WriteAllText($raceRelease, 'release') }
$raceA.WaitForExit()
$raceB.WaitForExit()
$raceCodes = @($raceA.ExitCode, $raceB.ExitCode)
Assert-Equal 1 (@($raceCodes | Where-Object { $_ -eq 0 }).Count) 'atomic: exactly one simultaneous non-Force writer exits 0'
Assert-Equal 1 (@($raceCodes | Where-Object { $_ -ne 0 }).Count) 'atomic: the other simultaneous writer refuses'
Assert-True -Condition (Test-Path -LiteralPath $raceTarget) 'atomic: the winner wrote the target'
$raceDoc = ([System.Text.Encoding]::UTF8.GetString([System.IO.File]::ReadAllBytes($raceTarget)) | ConvertFrom-Json)
Assert-Equal 'printcheck.collector' (Get-Prop $raceDoc 'schema') 'atomic: winner output is a valid collector document'

# ---------------------------------------------------------------------------
# 5. sample document and CLI behavior
# ---------------------------------------------------------------------------

$sampleDoc = New-PrintCheckSampleDoc
Assert-Equal 'sample' (Get-Prop (Get-Prop $sampleDoc 'tool') 'mode') 'sample: tool mode is sample'
Assert-Equal 'FICTION-SAMPLE-HOST' (Get-Prop (Get-Prop $sampleDoc 'host') 'hostName') 'sample: fictional host name'
Assert-Match 'actual collector runtime' (Get-Prop (Get-Prop $sampleDoc 'host') 'powershellVersion') 'sample: PowerShell version is labeled as the actual collector runtime'
Assert-True -Condition (@(Get-Prop (Get-Prop (Get-Prop $sampleDoc 'sources') 'queues') 'items').Count -ge 2) 'sample: has fictional queues'
$sampleNames = @(Get-Prop (Get-Prop (Get-Prop $sampleDoc 'sources') 'queues') 'items' | ForEach-Object { Get-Prop $_ 'name' })
Assert-True -Condition (@($sampleNames | Where-Object { -not $_.StartsWith('FICTION-') }).Count -eq 0) 'sample: every queue name is visibly fictional'
Assert-Equal $null (Get-Prop @(Get-Prop (Get-Prop (Get-Prop $sampleDoc 'sources') 'ports') 'items')[0] 'description') 'sample: port descriptions are omitted'
Assert-Equal 0 (@(Get-Prop (Get-Prop $sampleDoc 'provenance') 'queriesExecuted')).Count 'sample: executed no queries'

$cliDir = Join-Path $tempRoot 'cli'
New-Item -ItemType Directory -Path $cliDir -Force | Out-Null
$cliOut = Join-Path $cliDir 'nested\sample.json'
$cliRun = Invoke-ChildPwsh -Arguments @('-File', $collectorPath, '-Sample', '-OutFile', $cliOut)
Assert-Equal 0 $cliRun.ExitCode 'cli: -Sample exits 0'
Assert-True -Condition (Test-Path -LiteralPath $cliOut) 'cli: -Sample wrote the output file'
$cliBytes = [System.IO.File]::ReadAllBytes($cliOut)
$cliBom = ($cliBytes.Length -ge 3) -and ($cliBytes[0] -eq 0xEF) -and ($cliBytes[1] -eq 0xBB) -and ($cliBytes[2] -eq 0xBF)
Assert-Equal $false $cliBom 'cli: output is UTF-8 without BOM'
$cliDoc = ([System.Text.Encoding]::UTF8.GetString($cliBytes) | ConvertFrom-Json)
Assert-Equal 'printcheck.collector' (Get-Prop $cliDoc 'schema') 'cli: output schema'
Assert-Equal 'sample' (Get-Prop (Get-Prop $cliDoc 'tool') 'mode') 'cli: output mode is sample'
Assert-True -Condition (@(Get-Prop $cliDoc 'unknowns').Count -ge 6) 'cli: output carries the unknown topics'

$hashBefore = (Get-FileHash -LiteralPath $cliOut -Algorithm SHA256).Hash
$cliRefuse = Invoke-ChildPwsh -Arguments @('-File', $collectorPath, '-Sample', '-OutFile', $cliOut)
Assert-True -Condition ($cliRefuse.ExitCode -ne 0) 'cli: refuses to overwrite without -Force (non-zero exit)'
Assert-Match 'overwrite' $cliRefuse.Output 'cli: refusal message mentions overwrite'
Assert-Equal $hashBefore (Get-FileHash -LiteralPath $cliOut -Algorithm SHA256).Hash 'cli: file untouched after refusal'
$cliForce = Invoke-ChildPwsh -Arguments @('-File', $collectorPath, '-Sample', '-OutFile', $cliOut, '-Force')
Assert-Equal 0 $cliForce.ExitCode 'cli: -Force overwrite exits 0'

# ---------------------------------------------------------------------------
# 6. argument validation
# ---------------------------------------------------------------------------

$threwMissing = $false
$missingMessage = ''
try { New-PrintCheckDoc -ProviderMap @{ queues = { @() }; drivers = { @() }; ports = { @() } } -Mode 'test' | Out-Null }
catch { $threwMissing = $true; $missingMessage = $_.Exception.Message }
Assert-True -Condition $threwMissing 'validate: missing host provider throws'
Assert-Match 'host' $missingMessage 'validate: message names the missing provider'

$threwMode = $false
$modeMessage = ''
try { New-TestDoc -ProviderMap (New-FakeProviders) -Mode 'bogus' | Out-Null }
catch { $threwMode = $true; $modeMessage = $_.Exception.Message }
Assert-True -Condition $threwMode 'validate: unknown mode throws'
Assert-Match 'Mode' $modeMessage 'validate: message names Mode'

# ---------------------------------------------------------------------------
# summary
# ---------------------------------------------------------------------------

Write-Host ''
Write-Host ('ASSERTIONS: ' + $script:Pass + ' passed, ' + $script:Fail + ' failed')
if ($script:Fail -gt 0) {
  Write-Host 'FAILED ASSERTIONS:'
  foreach ($failure in $script:Failures) { Write-Host ('  - ' + $failure) }
  Write-Host 'COLLECTOR TESTS: FAIL'
  exit 1
}
Write-Host 'COLLECTOR TESTS: PASS'
exit 0
