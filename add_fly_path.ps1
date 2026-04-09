$new = 'C:\Users\Admin\Desktop\centerbackendSETRAF-clean\frontend-center\environment'
$old = [Environment]::GetEnvironmentVariable('Path','User')
if (-not ($old -split ';' | Where-Object { $_ -eq $new })) {
  $value = if ([string]::IsNullOrEmpty($old)) { $new } else { "$old;$new" }
  [Environment]::SetEnvironmentVariable('Path', $value, 'User')
  Write-Output "Added $new to user PATH"
} else {
  Write-Output "Path already contains $new"
}