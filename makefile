RM = rm
DKRBUILD = docker buildx build
DKRBUILDARGS = --platform linux/amd64 -t
DKRSV = docker save
DKRUN = docker run
DKRUNARGS = --rm -p

TARGET = scratchasm

all: $(TARGET)

PORT ?= 3000:3000
COMPILED = scratchasm.tar

$(TARGET):
	$(DKRBUILD) $(DKRBUILDARGS) $(TARGET) --load .
export:
	$(DKRSV) -o $(COMPILED) $(TARGET)
run: $(TARGET)
	$(DKRUN) $(DKRUNARGS) $(PORT) $(TARGET)
clean:
	$(RM) -f $(COMPILED)