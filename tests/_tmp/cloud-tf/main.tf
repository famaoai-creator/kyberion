resource "aws_instance" "web" {
  ami = "ami-123"
  instance_type = "m5.24xlarge"
}
resource "aws_ebs_volume" "data" {
  size = 100
}