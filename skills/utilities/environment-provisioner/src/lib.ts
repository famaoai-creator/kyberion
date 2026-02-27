export function sanitizeName(name: string): string {
  return (name || 'service').replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
}

export function generateTerraformAWS(svc: any): string {
  const name = sanitizeName(svc.name);
  return (
    'resource "aws_instance" "' +
    name +
    '" {\\n' +
    '  ami           = "ami-0c55b159cbfafe1f0"\\n' +
    '  instance_type = "t3.micro"\\n' +
    '  tags = { Name = "' +
    svc.name +
    '" }\\n' +
    '}'
  );
}
