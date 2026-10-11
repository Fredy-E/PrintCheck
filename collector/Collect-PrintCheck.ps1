#requires -Version 5.1
# PrintCheck collector -- read-only Windows print metadata snapshot.
#
# WHAT THIS SCRIPT DOES (and nothing else):
#   * Reads, on explicit user invocation only, a small allowlisted set of
#     printer metadata through documented Microsoft interfaces:
#       - Get-Printer        (PrintManagement) -> queue name, driver name,
#                              port name, shared flag, reported status
#       - Get-PrinterDriver  (PrintManagement) -> driver name, environment,
#                              manufacturer, major version, driver version
#       - Get-PrinterPort    (PrintManagement) -> port name, description,
#                              host address, port number
#       - Get-CimInstance Win32_OperatingSystem -> OS caption/version/build/
#                              architecture (documented WMI class)
#     Reference: https://learn.microsoft.com/en-us/powershell/module/printmanagement/
#   * Writes one versioned JSON document (UTF-8, no BOM).
#
# WHAT THIS SCRIPT NEVER DOES:
#   * No print jobs, document names, or spooler contents are read.
#   * No printer/driver/port installation, deletion, or modification.
#   * No spooler service changes, no settings changes, no WPP toggles.
#   * No network probes, discovery, or packet capture.
#   * No SNMP community strings or other secrets are collected (the port
#     allowlist excludes every SNMP field).
#   * Provider exception text and port description text never leave the host:
#     failed sources are written as a bounded canonical code plus a fixed
#     generic message, and port descriptions are omitted from the document.
#   * Windows protected print mode state is NOT queried: no documented
#     read-only interface for it is used here; the report marks it unknown.
#
# MODES:
#   -Sample       Write clearly fictional built-in data. Executes no queries.
#   -LibraryOnly  Define functions only (used by the test suite). Never runs
#                 the collection entry point, so dot-sourcing and testing
#                 cannot trigger production queries.
#
# The collection entry point additionally refuses to run when the script is
# dot-sourced (InvocationName '.') regardless of -LibraryOnly.

[CmdletBinding()]
param(
  [string]$OutFile = '',
  [switch]$Sample,
  [switch]$Force,
  [switch]$LibraryOnly
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$script:PrintCheckVersion = '0.1.0'
$script:PrintCheckSchema = 'printcheck.collector'
$script:PrintCheckSchemaVersion = 1
$script:PrintCheckMaxItems = 500
$script:PrintCheckMaxString = 300

# Canonical, bounded error text. Raw provider exception text is never written.
$script:PrintCheckErrorText = @{
  'provider-error'       = 'The provider query failed; error details are omitted.'
  'provider-unavailable' = 'The provider is unavailable; details are omitted.'
  'error'                = 'An error was reported; details are omitted.'
}

# ---------------------------------------------------------------------------
# safe property / value helpers (strict-mode safe for objects that may lack
# any given property)
# ---------------------------------------------------------------------------

function Get-PrintCheckPropertyValue {
  param($Object, [string]$Name)
  if ($null -eq $Object) { return $null }
  if ($Object -is [System.Collections.IDictionary]) {
    if ($Object.Contains($Name)) { return $Object[$Name] }
    return $null
  }
  $property = $Object.PSObject.Properties[$Name]
  if ($null -eq $property) { return $null }
  return $property.Value
}

function ConvertTo-PrintCheckText {
  param($Value, [int]$MaxLength = 300)
  if ($null -eq $Value) { return $null }
  if ($Value -is [string]) {
    $text = $Value.Trim()
    if ($text.Length -eq 0) { return $null }
    if ($text.Length -gt $MaxLength) { return $text.Substring(0, $MaxLength) }
    return $text
  }
  if ($Value -is [bool]) { return [string]$Value }
  if ($Value -is [System.ValueType]) { return [string]$Value }
  return $null
}

function New-PrintCheckError {
  # Canonical bounded error object: only allowlisted codes and their fixed
  # generic messages ever reach the document; exception text is discarded.
  param([string]$Kind)
  if (-not $script:PrintCheckErrorText.ContainsKey($Kind)) { $Kind = 'error' }
  return [pscustomobject]@{ kind = $Kind; message = $script:PrintCheckErrorText[$Kind] }
}

# ---------------------------------------------------------------------------
# item normalizers (allowlist model: only these fields ever leave the host)
# ---------------------------------------------------------------------------

function ConvertTo-PrintCheckQueueItem {
  param($Raw)
  $name = ConvertTo-PrintCheckText -Value (Get-PrintCheckPropertyValue -Object $Raw -Name 'Name')
  if ([string]::IsNullOrEmpty($name)) { return $null }
  $shared = Get-PrintCheckPropertyValue -Object $Raw -Name 'Shared'
  $sharedValue = $null
  if ($shared -is [bool]) { $sharedValue = $shared }
  return [pscustomobject]@{
    name       = $name
    driverName = ConvertTo-PrintCheckText -Value (Get-PrintCheckPropertyValue -Object $Raw -Name 'DriverName')
    portName   = ConvertTo-PrintCheckText -Value (Get-PrintCheckPropertyValue -Object $Raw -Name 'PortName')
    shared     = $sharedValue
    status     = ConvertTo-PrintCheckText -Value (Get-PrintCheckPropertyValue -Object $Raw -Name 'PrinterStatus')
  }
}

function ConvertTo-PrintCheckDriverItem {
  param($Raw)
  $name = ConvertTo-PrintCheckText -Value (Get-PrintCheckPropertyValue -Object $Raw -Name 'Name')
  if ([string]::IsNullOrEmpty($name)) { return $null }
  return [pscustomobject]@{
    name         = $name
    environment  = ConvertTo-PrintCheckText -Value (Get-PrintCheckPropertyValue -Object $Raw -Name 'PrinterEnvironment')
    manufacturer = ConvertTo-PrintCheckText -Value (Get-PrintCheckPropertyValue -Object $Raw -Name 'Manufacturer')
    majorVersion = ConvertTo-PrintCheckText -Value (Get-PrintCheckPropertyValue -Object $Raw -Name 'MajorVersion')
    driverVersion = ConvertTo-PrintCheckText -Value (Get-PrintCheckPropertyValue -Object $Raw -Name 'DriverVersion')
  }
}

function ConvertTo-PrintCheckPortItem {
  param($Raw)
  $name = ConvertTo-PrintCheckText -Value (Get-PrintCheckPropertyValue -Object $Raw -Name 'Name')
  if ([string]::IsNullOrEmpty($name)) { return $null }
  return [pscustomobject]@{
    name        = $name
    # Port description is free text from the print subsystem; it is never
    # carried (the field stays null in every document).
    description = $null
    hostAddress = ConvertTo-PrintCheckText -Value (Get-PrintCheckPropertyValue -Object $Raw -Name 'PrinterHostAddress')
    portNumber  = ConvertTo-PrintCheckText -Value (Get-PrintCheckPropertyValue -Object $Raw -Name 'PortNumber')
  }
}

# ---------------------------------------------------------------------------
# bounded source collection: a failing source never fails the document
# ---------------------------------------------------------------------------

function Invoke-PrintCheckSource {
  param(
    [string]$Id,
    [string]$Api,
    [scriptblock]$Provider,
    [scriptblock]$Converter,
    [int]$MaxItems = 500
  )
  $ErrorActionPreference = 'Stop'
  $raw = @()
  $status = 'ok'
  $errorObject = $null
  try {
    $result = & $Provider
    if ($null -ne $result) { $raw = @($result) }
  } catch {
    $status = 'failed'
    $errorObject = New-PrintCheckError -Kind 'provider-error'
  }

  $items = New-Object System.Collections.ArrayList
  $dropped = 0
  $truncated = $false
  if ($status -eq 'ok') {
    foreach ($entry in $raw) {
      if ($items.Count -ge $MaxItems) { $truncated = $true; break }
      if ($null -eq $entry) { $dropped++; continue }
      $item = & $Converter $entry
      if ($null -eq $item) { $dropped++; continue }
      [void]$items.Add($item)
    }
  }

  return [pscustomobject]@{
    status           = $status
    api              = $Api
    error            = $errorObject
    count            = $raw.Count
    truncated        = $truncated
    droppedItemCount = $dropped
    items            = @($items)
  }
}

function New-PrintCheckHostBlock {
  param(
    [scriptblock]$Provider,
    [string]$MachineName,
    [string]$PowerShellVersion,
    [string]$ProcessorArchitecture
  )
  $ErrorActionPreference = 'Stop'
  $status = 'ok'
  $errorObject = $null
  $os = $null
  try {
    $raw = & $Provider
    if ($null -ne $raw) {
      $os = [pscustomobject]@{
        caption      = ConvertTo-PrintCheckText -Value (Get-PrintCheckPropertyValue -Object $raw -Name 'Caption')
        version      = ConvertTo-PrintCheckText -Value (Get-PrintCheckPropertyValue -Object $raw -Name 'Version')
        build        = ConvertTo-PrintCheckText -Value (Get-PrintCheckPropertyValue -Object $raw -Name 'BuildNumber')
        architecture = ConvertTo-PrintCheckText -Value (Get-PrintCheckPropertyValue -Object $raw -Name 'OSArchitecture')
      }
    }
  } catch {
    $status = 'failed'
    $errorObject = New-PrintCheckError -Kind 'provider-error'
  }
  return [pscustomobject]@{
    status                = $status
    api                   = 'Get-CimInstance Win32_OperatingSystem'
    error                 = $errorObject
    hostName              = ConvertTo-PrintCheckText -Value $MachineName
    powershellVersion     = ConvertTo-PrintCheckText -Value $PowerShellVersion
    processorArchitecture = ConvertTo-PrintCheckText -Value $ProcessorArchitecture
    os                    = $os
  }
}

# ---------------------------------------------------------------------------
# unknowns: these stay unknown / not tested by design
# ---------------------------------------------------------------------------

function Get-PrintCheckUnknowns {
  return @(
    [pscustomobject]@{ topic = 'mopria-certification'; state = 'not-tested'; reason = 'Mopria certification is a vendor program; queue metadata cannot establish it.' },
    [pscustomobject]@{ topic = 'ipp-escl-capability'; state = 'not-tested'; reason = 'IPP and eSCL support are not reported by the Windows APIs this collector uses.' },
    [pscustomobject]@{ topic = 'windows-protected-print-mode'; state = 'unknown'; reason = 'Windows protected print mode state is not queried by this tool; check Windows Settings on the target machine.' },
    [pscustomobject]@{ topic = 'print-success'; state = 'not-tested'; reason = 'No print job was submitted or monitored; this tool never reads print jobs.' },
    [pscustomobject]@{ topic = 'scan-success'; state = 'not-tested'; reason = 'No scan was performed or monitored.' },
    [pscustomobject]@{ topic = 'readiness'; state = 'not-tested'; reason = 'Queue, driver, and port metadata does not imply that printing or scanning will succeed.' }
  )
}

# ---------------------------------------------------------------------------
# providers
# ---------------------------------------------------------------------------

function Get-PrintCheckDefaultProviders {
  # Described, not invoked, unless the collection entry point runs.
  return @{
    queues  = { Get-Printer -ErrorAction Stop }
    drivers = { Get-PrinterDriver -ErrorAction Stop }
    ports   = { Get-PrinterPort -ErrorAction Stop }
    host    = { Get-CimInstance -ClassName Win32_OperatingSystem -ErrorAction Stop }
  }
}

# ---------------------------------------------------------------------------
# document assembly
# ---------------------------------------------------------------------------

function New-PrintCheckDoc {
  param(
    [Parameter(Mandatory = $true)][hashtable]$ProviderMap,
    [string]$Mode = 'production',
    [string]$MachineName = '',
    [string]$PowerShellVersion = '',
    [string]$ProcessorArchitecture = ''
  )
  if ($Mode -ne 'production' -and $Mode -ne 'sample' -and $Mode -ne 'test') {
    throw ('Mode must be production, sample, or test (got: ' + $Mode + ').')
  }
  foreach ($required in @('queues', 'drivers', 'ports', 'host')) {
    if (-not $ProviderMap.ContainsKey($required)) {
      throw ('ProviderMap must contain a ''' + $required + ''' provider.')
    }
  }
  if ([string]::IsNullOrEmpty($MachineName)) { $MachineName = [string]$env:COMPUTERNAME }
  if ([string]::IsNullOrEmpty($PowerShellVersion)) { $PowerShellVersion = $PSVersionTable.PSVersion.ToString() }
  if ([string]::IsNullOrEmpty($ProcessorArchitecture)) { $ProcessorArchitecture = [string]$env:PROCESSOR_ARCHITECTURE }

  $hostBlock = New-PrintCheckHostBlock -Provider $ProviderMap['host'] `
    -MachineName $MachineName -PowerShellVersion $PowerShellVersion -ProcessorArchitecture $ProcessorArchitecture

  $sources = [pscustomobject]@{
    queues  = Invoke-PrintCheckSource -Id 'queues' -Api 'Get-Printer (PrintManagement)' `
      -Provider $ProviderMap['queues'] -Converter { param($entry) ConvertTo-PrintCheckQueueItem -Raw $entry } `
      -MaxItems $script:PrintCheckMaxItems
    drivers = Invoke-PrintCheckSource -Id 'drivers' -Api 'Get-PrinterDriver (PrintManagement)' `
      -Provider $ProviderMap['drivers'] -Converter { param($entry) ConvertTo-PrintCheckDriverItem -Raw $entry } `
      -MaxItems $script:PrintCheckMaxItems
    ports   = Invoke-PrintCheckSource -Id 'ports' -Api 'Get-PrinterPort (PrintManagement)' `
      -Provider $ProviderMap['ports'] -Converter { param($entry) ConvertTo-PrintCheckPortItem -Raw $entry } `
      -MaxItems $script:PrintCheckMaxItems
  }

  $queries = @()
  if ($Mode -eq 'production') {
    $queries = @(
      'Get-Printer (PrintManagement)',
      'Get-PrinterDriver (PrintManagement)',
      'Get-PrinterPort (PrintManagement)',
      'Get-CimInstance Win32_OperatingSystem'
    )
  }

  return [pscustomobject]@{
    schema        = $script:PrintCheckSchema
    schemaVersion = $script:PrintCheckSchemaVersion
    tool          = [pscustomobject]@{ name = 'PrintCheck Collector'; version = $script:PrintCheckVersion; mode = $Mode }
    generatedAt   = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    host          = $hostBlock
    sources       = $sources
    unknowns      = Get-PrintCheckUnknowns
    limits        = [pscustomobject]@{ maxItemsPerSource = $script:PrintCheckMaxItems; maxStringLength = $script:PrintCheckMaxString }
    provenance    = [pscustomobject]@{ script = 'collector/Collect-PrintCheck.ps1'; mode = $Mode; queriesExecuted = $queries }
  }
}

function New-PrintCheckSampleDoc {
  # Clearly fictional built-in data. No query is executed for this document.
  $queues = @(
    [pscustomobject]@{ name = 'FICTION-Sample-Queue-Alpha'; driverName = 'Fictional Sample Print Driver'; portName = 'FICTION-Sample-Port-01'; shared = $false; status = 'Idle' },
    [pscustomobject]@{ name = 'FICTION-Sample-Queue-Beta'; driverName = 'Fictional Sample Print Driver'; portName = 'FICTION-Sample-Port-01'; shared = $true; status = 'Idle' },
    [pscustomobject]@{ name = 'FICTION-Sample-Queue-Fax'; driverName = 'Fictional Sample Fax Driver'; portName = 'FICTION-Sample-Port-Fax'; shared = $false; status = 'Idle' }
  )
  $drivers = @(
    [pscustomobject]@{ name = 'Fictional Sample Print Driver'; environment = 'Windows ARM64 (fictional)'; manufacturer = 'Fiction Works'; majorVersion = '4'; driverVersion = '1.0.0' },
    [pscustomobject]@{ name = 'Fictional Sample Fax Driver'; environment = 'Windows ARM64 (fictional)'; manufacturer = 'Fiction Works'; majorVersion = '3'; driverVersion = '3.1.2' }
  )
  $ports = @(
    [pscustomobject]@{ name = 'FICTION-Sample-Port-01'; description = $null; hostAddress = '192.0.2.10'; portNumber = '9100' },
    [pscustomobject]@{ name = 'FICTION-Sample-Port-Fax'; description = $null; hostAddress = $null; portNumber = $null }
  )
  return [pscustomobject]@{
    schema        = $script:PrintCheckSchema
    schemaVersion = $script:PrintCheckSchemaVersion
    tool          = [pscustomobject]@{ name = 'PrintCheck Collector'; version = $script:PrintCheckVersion; mode = 'sample' }
    generatedAt   = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    host          = [pscustomobject]@{
      status = 'ok'
      api = 'Fictional sample document (no queries were executed)'
      error = $null
      hostName = 'FICTION-SAMPLE-HOST'
      powershellVersion = ($PSVersionTable.PSVersion.ToString() + ' (actual collector runtime; sample content is fictional)')
      processorArchitecture = 'ARM64 (fictional sample)'
      os = [pscustomobject]@{
        caption = 'Fictional Sample Operating System'
        version = '10.0.99999'
        build = '99999'
        architecture = 'ARM64 (fictional sample)'
      }
    }
    sources = [pscustomobject]@{
      queues  = [pscustomobject]@{ status = 'ok'; api = 'Fictional sample (Get-Printer shape)'; error = $null; count = $queues.Count; truncated = $false; droppedItemCount = 0; items = $queues }
      drivers = [pscustomobject]@{ status = 'ok'; api = 'Fictional sample (Get-PrinterDriver shape)'; error = $null; count = $drivers.Count; truncated = $false; droppedItemCount = 0; items = $drivers }
      ports   = [pscustomobject]@{ status = 'ok'; api = 'Fictional sample (Get-PrinterPort shape)'; error = $null; count = $ports.Count; truncated = $false; droppedItemCount = 0; items = $ports }
    }
    unknowns   = Get-PrintCheckUnknowns
    limits     = [pscustomobject]@{ maxItemsPerSource = $script:PrintCheckMaxItems; maxStringLength = $script:PrintCheckMaxString }
    provenance = [pscustomobject]@{ script = 'collector/Collect-PrintCheck.ps1'; mode = 'sample'; queriesExecuted = @() }
  }
}

# ---------------------------------------------------------------------------
# output
# ---------------------------------------------------------------------------

function Write-PrintCheckDoc {
  param(
    [Parameter(Mandatory = $true)]$Doc,
    [Parameter(Mandatory = $true)][string]$Path,
    [switch]$Force
  )
  $resolved = [System.IO.Path]::GetFullPath($Path)
  $parent = [System.IO.Path]::GetDirectoryName($resolved)
  if (-not [string]::IsNullOrEmpty($parent) -and -not (Test-Path -LiteralPath $parent)) {
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
  }
  $json = $Doc | ConvertTo-Json -Depth 12
  $encoding = New-Object System.Text.UTF8Encoding($false)
  # No-Force uses FileMode.CreateNew: the refusal is enforced by the atomic
  # filesystem create itself (no check-then-write window), so two simultaneous
  # writers can never both overwrite the same path. -Force keeps deliberate
  # overwrite semantics via FileMode.Create.
  $mode = [System.IO.FileMode]::CreateNew
  if ($Force) { $mode = [System.IO.FileMode]::Create }
  $stream = $null
  $writer = $null
  try {
    $stream = [System.IO.File]::Open($resolved, $mode, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
    $writer = New-Object System.IO.StreamWriter($stream, $encoding)
    $writer.Write($json)
  } catch {
    if ([System.IO.Directory]::Exists($resolved)) {
      throw ('Output path is an existing directory, not a file: ' + $resolved + '.')
    }
    if (-not $Force -and [System.IO.File]::Exists($resolved)) {
      throw ('Refusing to overwrite existing file: ' + $resolved + '. Use -Force to overwrite.')
    }
    throw
  } finally {
    if ($null -ne $writer) { $writer.Dispose() }
    if ($null -ne $stream) { $stream.Dispose() }
  }
  return $resolved
}

# ---------------------------------------------------------------------------
# collection entry point (runs only on direct invocation)
# ---------------------------------------------------------------------------

function Invoke-PrintCheckMain {
  param(
    [string]$OutFile = '',
    [switch]$Sample,
    [switch]$Force
  )
  $script:PrintCheckMainRan = $true
  try {
    if ($Sample) {
      $doc = New-PrintCheckSampleDoc
    } else {
      $doc = New-PrintCheckDoc -ProviderMap (Get-PrintCheckDefaultProviders) -Mode 'production'
    }
    $target = $OutFile
    if ([string]::IsNullOrEmpty($target)) {
      $target = Join-Path (Get-Location).Path ('PrintCheck-collector-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.json')
    }
    $written = Write-PrintCheckDoc -Doc $doc -Path $target -Force:$Force
    Write-Host ('PrintCheck collector: wrote ' + $written)
    return 0
  } catch {
    $host.UI.WriteErrorLine('PrintCheck collector failed: ' + $_.Exception.Message)
    return 1
  }
}

if (-not $LibraryOnly -and $MyInvocation.InvocationName -ne '.') {
  $exitCode = Invoke-PrintCheckMain -OutFile $OutFile -Sample:$Sample -Force:$Force
  exit $exitCode
}
